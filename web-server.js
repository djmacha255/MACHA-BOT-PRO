const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'webState.json');
const PROFILE_DIR = path.join(ROOT, 'assets', 'profiles');

let botSocket = null;
let profileTimer = null;
const saverProcesses = new Map();
let state = {
  slots: Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    name: `MACHA SAVER ${String(index + 1).padStart(2, '0')}`,
    number: '',
    status: 'available',
    pairingCode: '',
    connectedAt: null
  })),
  chatbot: { enabled: false, personality: 'friendly', prompt: '' },
  profile: { enabled: false, intervalMinutes: 5, currentIndex: 0 }
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
  } catch (error) {
    console.error('Unable to load web state:', error.message);
  }
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let value = '';
    req.on('data', chunk => {
      value += chunk;
      if (value.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(value ? JSON.parse(value) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function cleanNumber(value) {
  const number = String(value || '').replace(/\D/g, '');
  return number.length >= 7 && number.length <= 15 ? number : null;
}

function profileFiles() {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  return fs.readdirSync(PROFILE_DIR)
    .filter(file => /\.(jpe?g|png)$/i.test(file))
    .map(file => path.join(PROFILE_DIR, file));
}

async function rotateProfile() {
  const files = profileFiles();
  if (!botSocket || !state.profile.enabled || files.length === 0) return;
  const file = files[state.profile.currentIndex % files.length];
  state.profile.currentIndex = (state.profile.currentIndex + 1) % files.length;
  try {
    await botSocket.updateProfilePicture(botSocket.user.id, { url: file });
    saveState();
  } catch (error) {
    console.error('Dynamic profile update failed:', error.message);
  }
}

function configureProfileTimer() {
  if (profileTimer) clearInterval(profileTimer);
  if (state.profile.enabled) {
    const interval = Math.max(1, Number(state.profile.intervalMinutes) || 5) * 60 * 1000;
    profileTimer = setInterval(rotateProfile, interval);
  }
}

function publicStatus() {
  return {
    brand: 'DJ MACHA 255',
    botName: global.botname || 'MACHA-BOT',
    online: Boolean(botSocket?.user),
    number: botSocket?.user?.id?.split(':')[0] || null,
    slots: state.slots.map(({ pairingCode, ...slot }) => ({
      ...slot,
      hasPairingCode: Boolean(pairingCode)
    })),
    chatbot: state.chatbot,
    profile: { ...state.profile, images: profileFiles().length }
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, publicStatus());

  if (req.method === 'POST' && url.pathname === '/api/pair') {
    let data;
    try { data = await body(req); } catch { return json(res, 400, { error: 'Invalid JSON payload.' }); }
    const slot = state.slots.find(item => item.id === Number(data.slot));
    const number = cleanNumber(data.number);
    if (!slot || !number) return json(res, 400, { error: 'Choose a saver and enter a valid international number.' });
    const sessionDir = path.join(ROOT, 'sessions', `saver-${slot.id}`);
    const existing = saverProcesses.get(slot.id);
    if (existing) existing.kill();
    try {
      fs.mkdirSync(path.dirname(sessionDir), { recursive: true });
      const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
        cwd: ROOT,
        env: {
          ...process.env,
          DISABLE_WEB_SERVER: '1',
          PHONE_NUMBER: number,
          SESSION_DIR: sessionDir,
          MACHA_SAVER_ID: String(slot.id)
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      saverProcesses.set(slot.id, child);
      slot.number = number;
      slot.status = 'pairing';
      slot.pairingCode = '';
      child.on('message', message => {
        if (message.type === 'pairing-code') {
          slot.pairingCode = message.code;
          saveState();
        }
        if (message.type === 'connected') {
          slot.status = 'connected';
          slot.connectedAt = new Date().toISOString();
          saveState();
        }
      });
      child.on('exit', () => {
        if (saverProcesses.get(slot.id) === child) saverProcesses.delete(slot.id);
        if (slot.status !== 'connected') slot.status = 'available';
        saveState();
      });
      child.stderr.on('data', value => console.error(`[saver-${slot.id}] ${value.toString().trim()}`));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Pairing process timed out.')), 30000);
        const onMessage = message => {
          if (message.type === 'pairing-code') {
            clearTimeout(timeout);
            child.off('message', onMessage);
            resolve();
          }
        };
        child.on('message', onMessage);
        child.once('error', error => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      saveState();
      return json(res, 200, { slot, instructions: 'WhatsApp > Linked devices > Link a device > Link with phone number.' });
    } catch (error) {
      console.error('Pairing request failed:', error.message);
      return json(res, 502, { error: 'Pairing code could not be generated. Confirm the number and try again.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/chatbot') {
    let data;
    try { data = await body(req); } catch { return json(res, 400, { error: 'Invalid JSON payload.' }); }
    state.chatbot = {
      enabled: Boolean(data.enabled),
      personality: String(data.personality || 'friendly').slice(0, 40),
      prompt: String(data.prompt || '').slice(0, 500)
    };
    saveState();
    return json(res, 200, state.chatbot);
  }

  if (req.method === 'POST' && url.pathname === '/api/profile') {
    let data;
    try { data = await body(req); } catch { return json(res, 400, { error: 'Invalid JSON payload.' }); }
    state.profile.enabled = Boolean(data.enabled);
    state.profile.intervalMinutes = Math.min(1440, Math.max(1, Number(data.intervalMinutes) || 5));
    saveState();
    configureProfileTimer();
    if (state.profile.enabled) await rotateProfile();
    return json(res, 200, state.profile);
  }

  return json(res, 404, { error: 'Not found.' });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!file.startsWith(path.resolve(PUBLIC_DIR)) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end('Not found');
  }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function setBotSocket(socket) {
  botSocket = socket;
}

loadState();
configureProfileTimer();
http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url).catch(error => {
    console.error('Web API error:', error.message);
    json(res, 500, { error: 'Unexpected server error.' });
  });
  serveStatic(req, res, url);
}).listen(PORT, () => console.log(`🌐 MACHA dashboard: http://localhost:${PORT}`));

module.exports = { setBotSocket };
