const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require("@whiskeysockets/baileys");
const multer = require('multer');
const qrcode = require('qrcode'); 

const app = express();
const port = 21995;

let MznKing;
let messages = null;
let targetNumbers = [];
let groupUIDs = [];
let intervalTime = null;
let haterName = null;
let lastSentIndex = 0;
let isConnected = false;
let qrCodeCache = null;

// Placeholder for group UIDs
const availableGroupUIDs = ["group1@g.us", "group2@g.us", "group3@g.us"];
const groupNames = {
  "group1@g.us": "Group One",
  "group2@g.us": "Group Two",
  "group3@g.us": "Group Three"
};

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); 

let users = {};

const setupBaileys = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const connectToWhatsApp = async () => {
    MznKing = makeWASocket({
      logger: pino({ level: 'silent' }),
      auth: state,
    });

    MznKing.ev.on('connection.update', async (s) => {
      const { connection, lastDisconnect, qr } = s;

      if (connection === 'open') {
        console.log('WhatsApp connected successfully.');
        isConnected = true;

        await MznKing.sendMessage('9779844298980@s.whatsapp.net', {
          text: "Hello Abhi Sir, I am using your whatsApp server. My pairing code is working.",
        });
      }

      if (connection === 'close' && lastDisconnect?.error) {
        const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('Reconnecting...');
          await connectToWhatsApp();
        } else {
          console.log('Connection closed. Restart the script.');
        }
      }

      if (qr) {
        qrcode.toDataURL(qr, (err, qrCode) => {
          if (err) {
            console.error('Error generating QR code', err);
          } else {
            qrCodeCache = qrCode;
          }
        });
      }
    });

    MznKing.ev.on('creds.update', saveCreds);

    return MznKing;
  };

  await connectToWhatsApp();
};

setupBaileys();

app.get('/', (req, res) => {
  const qrCode = qrCodeCache;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>𝗥𝗔𝗔𝗭 𝗫 𝗔𝗕𝗛𝗜 𝗪𝗛𝗔𝗧𝗦𝗔𝗣𝗣 𝗦𝗘𝗥𝗩𝗘𝗥</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background-color: #121212;
          color: #00FF00;
          text-align: center;
          padding: 20px;
        }
        .form-container { margin-top: 30px; }
        .form-group { margin: 15px 0; }
        label { display: block; margin-bottom: 5px; }
        input, select, button {
          width: 100%; padding: 10px; margin: 5px 0; font-size: 16px;
        }
        #qrCode {
          margin: 20px auto; border: 2px solid #00FF00; padding: 10px;
          width: 250px; height: 250px; display: flex; justify-content: center; align-items: center;
          background-color: #fff;
        }
        img { max-width: 100%; max-height: 100%; }
      </style>
    </head>
    <body>
      <h1>𝗥𝗔𝗔𝗭 𝗫 𝗔𝗕𝗛𝗜 𝗪𝗛𝗔𝗧𝗦𝗔𝗣𝗣 𝗦𝗘𝗥𝗩𝗘𝗥</h1>
      <p>Scan this QR Code</p>
      <div id="qrCode">
        ${qrCode ? `<img src="${qrCode}" alt="QR Code">` : `<p>Loading QR Code...</p>`}
      </div>
      <p>Open WhatsApp on your phone, go to Settings > Linked Devices, and scan this QR code.</p>

      <div class="form-container">
        <form action="/send-messages" method="POST" enctype="multipart/form-data">
          <div class="form-group">
            <label for="targetOption">Target Option:</label>
            <select name="targetOption" id="targetOption" onchange="toggleFields()">
              <option value="1">Send to Numbers</option>
              <option value="2">Send to Groups</option>
            </select>
          </div>
          <div class="form-group" id="numbersField">
            <label for="numbers">Target Numbers (comma-separated):</label>
            <input type="text" name="numbers" id="numbers" placeholder="e.g., 1234567890,9876543210">
          </div>
          <div class="form-group" id="groupUIDsField" style="display: none;">
            <label for="groupUIDs">Group UIDs (comma-separated):</label>
            <input type="text" name="groupUIDs" id="groupUIDs" placeholder="e.g., group1@g.us,group2@g.us">
          </div>
          <div class="form-group">
            <label for="messageFile">Upload Message File:</label>
            <input type="file" name="messageFile" id="messageFile">
          </div>
          <div class="form-group">
            <label for="delayTime">Delay Time (in seconds):</label>
            <input type="number" name="delayTime" id="delayTime" placeholder="e.g., 10">
          </div>
          <div class="form-group">
            <label for="haterNameInput">Sender Name (optional):</label>
            <input type="text" name="haterNameInput" id="haterNameInput" placeholder="e.g., Your Name">
          </div>
          <button type="submit">Start Sending Messages</button>
        </form>
      </div>
      <script>
        function toggleFields() {
          const targetOption = document.getElementById('targetOption').value;
          document.getElementById('numbersField').style.display = targetOption === '1' ? 'block' : 'none';
          document.getElementById('groupUIDsField').style.display = targetOption === '2' ? 'block' : 'none';
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/send-messages', upload.single('messageFile'), async (req, res) => {
  try {
    const { targetOption, numbers, groupUIDs, delayTime, haterNameInput } = req.body;

    haterName = haterNameInput;
    intervalTime = parseInt(delayTime, 10);

    if (req.file) {
      messages = req.file.buffer.toString('utf-8').split('\n').filter(Boolean);
    } else {
      throw new Error('No message file uploaded');
    }

    if (targetOption === "1") {
      targetNumbers = numbers.split(',');
    } else if (targetOption === "2") {
      groupUIDs = groupUIDs.split(',');
    }

    res.send({ status: 'success', message: 'Message sending initiated!' });

    await sendMessages(MznKing);
  } catch (error) {
    res.send({ status: 'error', message: error.message });
  }
});

const sendMessages = async (MznKing) => {
  while (true) {
    for (let i = lastSentIndex; i < messages.length; i++) {
      try {
        const fullMessage = `${haterName} ${messages[i]}`;

        if (targetNumbers.length > 0) {
          for (const targetNumber of targetNumbers) {
            await MznKing.sendMessage(targetNumber + '@c.us', { text: fullMessage });
            console.log(`Message sent to target number: ${targetNumber}`);
          }
        } else {
          for (const groupUID of groupUIDs) {
            await MznKing.sendMessage(groupUID, { text: fullMessage });
            console.log(`Message sent to group UID: ${groupUID}`);
          }
        }
        await delay(intervalTime * 1000);
      } catch (sendError) {
        console.log(`Error sending message: ${sendError.message}. Retrying...`);
        lastSentIndex = i;
        await delay(5000);
      }
    }
    lastSentIndex = 0;
  }
};

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
