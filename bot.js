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

let checking = false;

async function loadActivity() {
  try {
    return JSON.parse(
      await fs.readFile(DATA_FILE, 'utf8')
    );
  } catch {
    return {};
  }
}

async function saveActivity(activity) {
  await fs.writeFile(
    DATA_FILE,
    JSON.stringify(activity, null, 2)
  );
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('VYREX GUARDIAN connected.');
    }

    if (connection === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          startBot().catch(console.error);
        }, 5000);
      } else {
        console.log('WhatsApp logged out. Manual reconnection required.');
      }
    }
  });

  const activity = await loadActivity();
  const warned = new Set();

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      const groupId = message.key.remoteJid;
      const sender = message.key.participant;

      if (
        !groupId?.endsWith('@g.us') ||
        !sender ||
        message.key.fromMe ||
        !message.message
      ) {
        continue;
      }

      try {
        const metadata = await sock.groupMetadata(groupId);

        if (metadata.subject !== GROUP_NAME) {
          continue;
        }

        if (!activity[groupId]) {
          activity[groupId] = {};
        }

        activity[groupId][sender] = Date.now();

        warned.delete(`${groupId}:${sender}`);

        await saveActivity(activity);
      } catch (error) {
        console.error('Could not record activity:', error.message);
      }
    }
  });

  setInterval(async () => {
    if (checking) return;
    checking = true;

    try {
      const groups = await sock.groupFetchAllParticipating();
      const now = Date.now();
      const sevenDays = INACTIVITY_DAYS * 24 * 60 * 60 * 1000;

      for (const [groupId, group] of Object.entries(groups)) {
        if (group.subject !== GROUP_NAME) continue;

        const metadata = await sock.groupMetadata(groupId);

        for (const member of metadata.participants) {
          const id = member.id;

          // Never warn members without a recorded activity baseline.
          const lastActive = activity[groupId]?.[id];

          if (!lastActive) continue;

          if (now - lastActive < sevenDays) continue;

          const warningKey = `${groupId}:${id}`;

          if (warned.has(warningKey)) continue;

          await sock.sendMessage(groupId, {
            text:
              `@${id.split('@')[0]}, our records show you have not sent a message in VYREX for seven days. Please participate to remain active in the group.`,
            mentions: [id]
          });

          warned.add(warningKey);
        }
      }
    } catch (error) {
      console.error('Inactivity check failed:', error.message);
    } finally {
      checking = false;
    }
  }, CHECK_INTERVAL);

  console.log('VYREX GUARDIAN started. Monitoring is not yet verified.');
}

startBot().catch(console.error);
