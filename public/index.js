import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { makeWASocket } from "@whiskeysockets/baileys";
import pino from 'pino';
import NodeCache from 'node-cache';
import multer from 'multer';
import { delay, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });
const activeSessions = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, 'data');

(async () => {
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
        console.error("Error creating data directory", err);
    }
})();

async function createSessionFolder(sessionId) {
    const sessionPath = path.join(dataDir, sessionId);
    try {
        await fs.mkdir(sessionPath, { recursive: true });
    } catch (err) {
        console.error(`Error creating session folder for ${sessionId}`, err);
    }
    return sessionPath;
}

async function isDuplicateCreds(credsFilePath) {
    const credsHash = await fs.readFile(credsFilePath, 'utf-8');
    for (const [sessionId, socket] of activeSessions) {
        const sessionPath = path.join(dataDir, sessionId, 'creds.json');
        if (await fs.readFile(sessionPath, 'utf-8') === credsHash) {
            return true;
        }
    }
    return false;
}

app.post('/stop-session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    if (activeSessions.has(sessionId)) {
        const socket = activeSessions.get(sessionId);
        socket.ev.emit('close');
        activeSessions.delete(sessionId);
        const sessionPath = path.join(dataDir, sessionId);
        await fs.rmdir(sessionPath, { recursive: true }).catch(err => {
            console.warn(`Cleanup failed for ${sessionId}:`, err);
        });
        res.send(`Session ${sessionId} stopped.`);
    } else {
        res.status(404).send(`Session ${sessionId} not found.`);
    }
});

app.get('/sessions', (req, res) => {
    res.send(Array.from(activeSessions.keys()));
});

app.post('/send-message', upload.single('messageFile'), async (req, res) => {
    try {
        const { creds, name, targetNumber, targetType, delayTime } = req.body;

        if (!creds) {
            return res.status(400).send('Creds.json content is required.');
        }
        if (!req.file) {
            return res.status(400).send('Message file is required.');
        }

        const messageFilePath = req.file.path;

        if (await isDuplicateCredsFromText(creds)) {
            return res.status(400).send('This credentials data is already in use. Please provide unique session data.');
        }

        const sessionId = `session_${Date.now()}`;
        const sessionPath = await createSessionFolder(sessionId);

        await fs.writeFile(path.join(sessionPath, 'creds.json'), creds);

        const messages = (await fs.readFile(messageFilePath, 'utf-8')).split('\n').filter(Boolean);

        const data = {
            name,
            targetNumber,
            targetType,
            messages,
            delayTime: parseInt(delayTime, 10),
        };

        await fs.writeFile(path.join(sessionPath, 'data.json'), JSON.stringify(data, null, 2));
        setImmediate(() => safeStartWhatsAppSession(sessionId));
        res.send(`Session ${sessionId} started.`);
    } catch (error) {
        console.error("Processing error:", error);
        res.status(500).send('Failed to process the request.');
    }
});

async function isDuplicateCredsFromText(credsText) {
    const credsHash = credsText;
    for (const [sessionId, socket] of activeSessions) {
        const sessionPath = path.join(dataDir, sessionId, 'creds.json');
        const sessionCreds = await fs.readFile(sessionPath, 'utf-8');
        if (sessionCreds === credsHash) {
            return true;
        }
    }
    return false;
}

async function startWhatsAppSession(sessionId) {
    const sessionPath = path.join(dataDir, sessionId);
    
    try {
        const data = JSON.parse(await fs.readFile(path.join(sessionPath, 'data.json'), 'utf-8'));
        const { name, targetNumber, targetType, messages, delayTime } = data;

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const msgRetryCounterCache = new NodeCache();

        const socket = makeWASocket({
            logger: pino({ level: 'silent' }),
            browser: ['Chrome (Linux)', '', ''],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
            msgRetryCounterCache,
        });

        activeSessions.set(sessionId, socket);

        socket.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                console.log(`Session ${sessionId} connected.`);
                const targetJid = targetType === 'group' ? `${targetNumber}@g.us` : `${targetNumber}@s.whatsapp.net`;
                
                for (let i = 0; messages.length && activeSessions.has(sessionId); i++) {
                    const message = messages[i];
                    await sendMessage(socket, targetJid, name, message, delayTime, i);
                }
            }

            if (connection === "close") {
                handleSessionClosure(sessionId, lastDisconnect, sessionPath);
            }
        });

        socket.ev.on('creds.update', saveCreds);
    } catch (error) {
        console.error(`Error in session ${sessionId}:`, error);
        
        setTimeout(() => safeStartWhatsAppSession(sessionId), 60000);
    }
}

async function sendMessage(socket, targetJid, name, message, delayTime, index) {
    try {
        await socket.sendMessage(targetJid, { text: `${name} ${message}` });
        console.log(`Message ${index + 1} sent to ${targetJid}: ${name} ${message}`);
        await delay(delayTime * 1000);
    } catch (err) {
        console.error(`Error sending message ${index + 1} to ${targetJid}:`, err);
        await delay(5000);
    }
}

async function handleSessionClosure(sessionId, lastDisconnect, sessionPath) {
    const isAuthError = lastDisconnect?.error?.output?.statusCode === 401;
    if (isAuthError) {
        console.log(`Invalid credentials for session: ${sessionId}. Removing session folder...`);
        await fs.rm(sessionPath, { recursive: true, force: true }).catch(err => {
            console.warn(`Failed to remove session folder: ${sessionId}`, err);
        });
    } else {
        console.log(`Connection closed for session ${sessionId}. Attempting restart...`);
        setTimeout(() => safeStartWhatsAppSession(sessionId), 60000);
    }
}

async function safeStartWhatsAppSession(sessionId) {
    try {
        await startWhatsAppSession(sessionId);
    } catch (err) {
        console.error(`Failed to start session ${sessionId}:`, err);
        setTimeout(() => safeStartWhatsAppSession(sessionId), 10000);
    }
}

async function autoStartSessions() {
    try {
        const sessionFolders = await fs.readdir(dataDir);
        for (const folder of sessionFolders) {
            const sessionPath = path.join(dataDir, folder);
            const isDir = (await fs.lstat(sessionPath)).isDirectory();
            if (isDir) {
                console.log(`Auto-starting session: ${folder}`);
                setImmediate(() => safeStartWhatsAppSession(folder));
            }
        }
    } catch (err) {
        console.warn("Error auto-starting sessions", err);
    }
}

const port = process.env.PORT || 21995;
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    autoStartSessions(); 
});
