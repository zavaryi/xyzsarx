const { Client, RichPresence } = require('discord.js-selfbot-v13');
const express = require('express');

const TOKEN = process.env.TOKEN;
const APPLICATION_ID = process.env.APPLICATION_ID || null;
const PORT = process.env.PORT || 3000;
const MEMORY_LIMIT_MB = 200;

if (!TOKEN) {
  console.error('[ERROR] TOKEN is not set. Exiting.');
  process.exit(1);
}

// Hardcoded start point — never changes across restarts/redeploys.
// Discord counts elapsed time client-side as (now - START_TIMESTAMP).
const START_TIMESTAMP = new Date('2026-03-22T16:15:20.642Z').getTime();

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

// ─── Health server ────────────────────────────────────────────────────────────
const app = express();
app.get('/', (_req, res) => {
  const mem = process.memoryUsage();
  const elapsedMs = Date.now() - START_TIMESTAMP;
  const h = Math.floor(elapsedMs / 3600000);
  const m = Math.floor((elapsedMs % 3600000) / 60000);
  const s = Math.floor((elapsedMs % 60000) / 1000);
  res.json({
    status: 'alive',
    uptime_s: Math.floor(process.uptime()),
    elapsed: `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`,
    memory_mb: Math.round(mem.heapUsed / 1024 / 1024),
  });
});
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`[HTTP] Health server on port ${PORT}`));

// ─── State ────────────────────────────────────────────────────────────────────
let client = null;
let reconnectTimeout = null;
let presenceInterval = null;
let memCheckInterval = null;
let resolvedImage = null;
let resolvedAppId = null;

// ─── Memory watcher ───────────────────────────────────────────────────────────
function startMemoryWatcher() {
  if (memCheckInterval) clearInterval(memCheckInterval);
  memCheckInterval = setInterval(() => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB  = Math.round(mem.rss / 1024 / 1024);
    console.log(`[Mem] heap: ${heapMB}MB | rss: ${rssMB}MB`);

    if (heapMB >= MEMORY_LIMIT_MB) {
      console.warn(`[Mem] ⚠ Heap at ${heapMB}MB — recycling Discord client to free memory...`);
      // Destroy old client (frees all socket buffers, event listeners, caches)
      // resolvedImage / resolvedAppId are kept so we skip re-resolution
      scheduleReconnect(1000);
    }
  }, 5 * 60 * 1000); // check every 5 minutes
}

// ─── Image resolver ───────────────────────────────────────────────────────────
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
  console.log('[Image] ✗ Could not resolve image.');
  return { image: null, appId: FALLBACK_APP_IDS[0] || null };
}

// ─── Presence sender ──────────────────────────────────────────────────────────
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

  if (appId) rpc.setApplicationId(appId);
  if (image) rpc.setAssetsLargeImage(image);

  try {
    client.user.setPresence({ activities: [rpc], status: config.status });
    client.user.setStatus(config.status);
    const elapsedMs = Date.now() - START_TIMESTAMP;
    const h = Math.floor(elapsedMs / 3600000);
    const m = Math.floor((elapsedMs % 3600000) / 60000);
    const s = Math.floor((elapsedMs % 60000) / 1000);
    console.log(`[RPC] ✓ ${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} | appId: ${appId} | img: ${image ? 'yes' : 'no'}`);
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
  if (appId) activity.application_id = appId;
  if (image) activity.assets = { large_image: image };
  client.ws.broadcast({ op: 3, d: { since: null, afk: false, status: config.status, activities: [activity] } });
  console.log('[RPC] ✓ Presence sent via raw WS fallback');
}

// ─── Reconnect logic ──────────────────────────────────────────────────────────
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

// ─── Main connect ─────────────────────────────────────────────────────────────
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

  client.on('disconnect', () => { console.warn('[Bot] Disconnected'); scheduleReconnect(5000); });
  client.on('shardDisconnect', (_ev, id) => { console.warn(`[Bot] Shard ${id} disconnected`); scheduleReconnect(5000); });
  client.on('error', (err) => { console.error('[Bot] Error:', err.message); scheduleReconnect(10000); });

  client.login(TOKEN).catch((err) => {
    console.error('[Bot] Login failed:', err.message);
    destroyClient();
    scheduleReconnect(15000);
  });
}

process.on('uncaughtException', (err) => { console.error('[Process] Uncaught exception:', err.message); scheduleReconnect(10000); });
process.on('unhandledRejection', (reason) => { console.error('[Process] Unhandled rejection:', reason); });

startMemoryWatcher();
connect();
