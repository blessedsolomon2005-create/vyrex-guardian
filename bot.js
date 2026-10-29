import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

import pino from 'pino';
import fs from 'node:fs/promises';

const GROUP_NAME = 'VYREX';
const INACTIVITY_DAYS = 7;

const CHECK_INTERVAL = 60 * 60 * 1000;
const DATA_FILE = './activity.json';

async function loadActivity() {
  try {
    return JSON.parse(
      await fs.readFile(DATA_FILE, 'utf8')
    );
  } catch {
    return {};
  }
}

async function saveActivity(data) {
  await fs.writeFile(
    DATA_FILE,
    JSON.stringify(data, null, 2)
  );
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(
        'WhatsApp QR generated. Use a secure terminal to display it.'
      );
    }

    if (connection === 'open') {
      console.log('VYREX GUARDIAN connected.');
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startBot, 5000);
      } else {
        console.log(
          'Logged out. Reconnect manually.'
        );
      }
    }
  });

  let activity = await loadActivity();
  const warned = new Set();

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (!message.key.remoteJid?.endsWith('@g.us')) {
        continue;
      }

      if (message.key.fromMe) {
        continue;
      }

      const group = message.key.remoteJid;
      const sender = message.key.participant;

      if (!sender) continue;

      if (!activity[group]) activity[group] = {};

      activity[group][sender] = Date.now();

      await saveActivity(activity);
    }
  });

  setInterval(async () => {
    const groups = await sock.groupFetchAllParticipating();

    for (const [groupId, group] of Object.entries(groups)) {
      if (group.subject !== GROUP_NAME) continue;

      const participants = group.participants || [];

      for (const participant of participants) {
        const id = participant.id;

        const lastActive =
          activity[groupId]?.[id] || 0;

        const inactiveDays =
          (Date.now() - lastActive) /
          (24 * 60 * 60 * 1000);

        if (inactiveDays >= INACTIVITY_DAYS) {
          const warningKey = `${groupId}:${id}`;

          if (warned.has(warningKey)) continue;

          await sock.sendMessage(groupId, {
            text:
              `@${id.split('@')[0]}, you have been inactive for 7 days. ` +
              'Please participate in the VYREX group to remain a member.',
            mentions: [id]
          });

          warned.add(warningKey);
        }
      }
    }
  }, CHECK_INTERVAL);
}

startBot().catch(console.error);
