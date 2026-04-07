const { Client, RichPresence } = require('discord.js-selfbot-v13');
const express = require('express');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TOKEN;
const APPLICATION_ID = process.env.APPLICATION_ID || null;
const PORT = process.env.PORT || 3000;
const START_TIME_FILE = path.join(__dirname, '.start_time');

if (!TOKEN) {
  console.error('[ERROR] TOKEN is not set. Exiting.');
  process.exit(1);
}

const INITIAL_OFFSET_MS = ((376 * 3600) + (45 * 60) + 32) * 1000;

function getStartTimestamp() {
  try {
    if (fs.existsSync(START_TIME_FILE)) {
      const saved = parseInt(fs.readFileSync(START_TIME_FILE, 'utf8').trim(), 10);
      if (!isNaN(saved) && saved > 0) {
        console.log('[Timer] Resumed — showing elapsed from:', new Date(saved).toISOString());
        return saved;
      }
    }
  } catch (_) {}
  const backdated = Date.now() - INITIAL_OFFSET_MS;
  try { fs.writeFileSync(START_TIME_FILE, String(backdated)); } catch (_) {}
  console.log('[Timer] First run — backdated so Discord shows 376:45:32');
  return backdated;
}

const START_TIMESTAMP = getStartTimestamp();

const config = {
  activityName: 'ego',
  details: 'ɴᴏᴛ ɪɴ ᴍʏ ᴘʀɪᴍᴇ, ʙᴜᴛ ꜱᴛɪʟʟ.',
  state: 'Ｉ\'Ｍ ＷＩＮＮＩＮＧ． 🏆🔥',
  largeImageUrl: 'https://i.pinimg.com/736x/41/a8/51/41a851bdc17f04011b3bd019e0996840.jpg',
  buttonLabel: '🌎🌎🌎',
  buttonUrl: 'https://guns.lol/376k',
  status: 'dnd',
};

const USER_ID = Buffer.from(TOKEN.split('.')[0], 'base64').toString('utf8');

const FALLBACK_APP_IDS = [
  APPLICATION_ID,
  '880218394199220334',
  '755600276941176913',
  '814288819477020702',
  USER_ID,
].filter(Boolean);

const app = express();
app.get('/', (_req, res) => res.json({ status: 'alive', uptime: Math.floor(process.uptime()), timer_from: new Date(START_TIMESTAMP).toISOString() }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`[HTTP] Health server on port ${PORT}`));

let client = null;
let reconnectTimeout = null;
let presenceInterval = null;
let resolvedImage = null;
let resolvedAppId = null;

async function tryResolveImage() {
  for (const appId of FALLBACK_APP_IDS) {
    try {
      console.log(`[Image] Trying appId ${appId}...`);
      const results = await RichPresence.getExternal(client, appId, config.largeImageUrl);
      if (results?.[0]?.external_asset_path) {
        const imagePath = `mp:${results[0].external_asset_path}`;
        console.log('[Image] ✓ Resolved:', imagePath, '| appId:', appId);
        return { image: imagePath, appId };
      }
    } catch (err) {
      console.log(`[Image] appId ${appId} failed: ${err.message}`);
    }
  }
  console.log('[Image] ✗ Could not resolve. Set APPLICATION_ID env var for reliable image + button support.');
  return { image: null, appId: FALLBACK_APP_IDS[0] || null };
}

async function sendPresence() {
  if (!client?.user) return;

  const appId = resolvedAppId;
  const image = resolvedImage;

  const rpc = new RichPresence(client)
    .setType('COMPETING')
    .setName(config.activityName)
    .setDetails(config.details)
    .setState(config.state)
    .setStartTimestamp(START_TIMESTAMP)
    .addButton(config.buttonLabel, config.buttonUrl)
    .addButton(config.buttonLabel, config.buttonUrl);

  if (appId) {
    rpc.setApplicationId(appId);
  }

  if (image) {
    rpc.setAssetsLargeImage(image);
  }

  try {
    client.user.setPresence({
      activities: [rpc],
      status: config.status,
    });
    client.user.setStatus(config.status);
    console.log(`[RPC] ✓ Set | appId: ${appId} | image: ${image ? 'yes' : 'no'} | buttons → ${config.buttonUrl}`);
    console.log('[RPC] NOTE: Buttons only work when clicked from ANOTHER account (Discord limitation for self-view).');
  } catch (err) {
    console.error('[RPC] Builder error, falling back to raw WS:', err.message);
    sendRawFallback(appId, image);
  }
}

function sendRawFallback(appId, image) {
  if (!client?.ws) return;
  const activity = {
    name: config.activityName,
    type: 5,
    details: config.details,
    state: config.state,
    timestamps: { start: START_TIMESTAMP },
    buttons: [config.buttonLabel, config.buttonLabel],
    metadata: { button_urls: [config.buttonUrl, config.buttonUrl] },
  };
  if (appId) {
    activity.application_id = appId;
  }
  if (image) {
    activity.assets = { large_image: image };
  }
  client.ws.broadcast({ op: 3, d: { since: null, afk: false, status: config.status, activities: [activity] } });
  console.log('[RPC] ✓ Presence sent via raw WS fallback');
}

function scheduleReconnect(delay = 5000) {
  if (reconnectTimeout) return;
  console.log(`[Bot] Reconnecting in ${delay / 1000}s...`);
  reconnectTimeout = setTimeout(() => { reconnectTimeout = null; connect(); }, delay);
}

function destroyClient() {
  if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }
  if (!client) return;
  try { client.destroy(); } catch (_) {}
  client = null;
}

function connect() {
  destroyClient();
  client = new Client({
    checkUpdate: false,
    presence: { status: config.status, activities: [] },
  });

  client.once('ready', async () => {
    console.log(`[Bot] ✓ Logged in as ${client.user.tag}`);

    if (!resolvedImage) {
      const result = await tryResolveImage();
      resolvedImage = result.image;
      resolvedAppId = result.appId;
    }

    await sendPresence();
    presenceInterval = setInterval(sendPresence, 20 * 60 * 1000);
  });

  client.on('disconnect', () => {
    console.warn('[Bot] Disconnected — reconnecting...');
    scheduleReconnect(5000);
  });

  client.on('shardDisconnect', (_ev, id) => {
    console.warn(`[Bot] Shard ${id} disconnected — reconnecting...`);
    scheduleReconnect(5000);
  });

  client.on('error', (err) => {
    console.error('[Bot] Error:', err.message);
    scheduleReconnect(10000);
  });

  client.login(TOKEN).catch((err) => {
    console.error('[Bot] Login failed:', err.message);
    destroyClient();
    scheduleReconnect(15000);
  });
}

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.message);
  scheduleReconnect(10000);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

connect();
