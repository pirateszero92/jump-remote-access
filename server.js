const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const express = require('express');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const GuacamoleLite = require('guacamole-lite');
const { Client: SshClient } = require('ssh2');
const { WebSocketServer } = require('ws');

const { encryptGuacamoleToken, getGuacamoleCryptKey } = require('./lib/guacamole-token');
const { buildRdpConnectionToken } = require('./lib/rdp-settings');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.cfg');
const TOKEN_TTL_MS = Number.parseInt(process.env.TOKEN_TTL_MS || String(6 * 60 * 60 * 1000), 10);
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour inactivity timeout
const WEBSOCKIFY_TARGET = process.env.WEBSOCKIFY_TARGET || 'http://websockify:6080';
const SSH_DEFAULT_IDLE_TIMEOUT_MS = Number.parseInt(process.env.SSH_DEFAULT_IDLE_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const SSH_MIN_IDLE_TIMEOUT_MS = Number.parseInt(process.env.SSH_MIN_IDLE_TIMEOUT_MS || String(60 * 1000), 10);
const SSH_MAX_IDLE_TIMEOUT_MS = Number.parseInt(process.env.SSH_MAX_IDLE_TIMEOUT_MS || String(12 * 60 * 60 * 1000), 10);
const SSH_KEEPALIVE_INTERVAL_MS = Number.parseInt(process.env.SSH_KEEPALIVE_INTERVAL_MS || String(20 * 1000), 10);
const SSH_KEEPALIVE_COUNT_MAX = Number.parseInt(process.env.SSH_KEEPALIVE_COUNT_MAX || '4', 10);
const SSH_READY_TIMEOUT_MS = Number.parseInt(process.env.SSH_READY_TIMEOUT_MS || String(15 * 1000), 10);
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number.parseInt(process.env.GUACD_PORT || '4822', 10);
const GUACAMOLE_WS_PORT = Number.parseInt(process.env.GUACAMOLE_WS_PORT || '4824', 10);

const APP_USER = (process.env.APP_USER || 'admin').trim();
const APP_PASS = (process.env.APP_PASS || 'password').trim();
const APP_SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex');
const GUACAMOLE_CRYPT_KEY = process.env.GUACAMOLE_CRYPT_KEY || APP_SECRET;

const app = express();
const server = http.createServer(app);

const vncSessions = new Map();
const sshSessions = new Map();
const rdpSessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(input, fallback) {
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

function isValidHost(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const host = value.trim();
  if (!host || host.length > 255) {
    return false;
  }

  return /^[a-zA-Z0-9._:\-]+$/.test(host);
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }

  return parsed;
}

function parseBoundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  if (parsed < min) {
    return min;
  }

  if (parsed > max) {
    return max;
  }

  return parsed;
}

function normalizeProto(input, fallback = 'VNC') {
  const proto = String(input || fallback).toUpperCase();
  if (proto === 'SSH' || proto === 'RDP') {
    return proto;
  }

  return 'VNC';
}

function defaultPortByProto(proto) {
  if (proto === 'SSH') {
    return 22;
  }

  if (proto === 'RDP') {
    return 3389;
  }

  return 5900;
}

function normalizeTargetPayload(payload, current = null) {
  const proto = normalizeProto(payload.proto, current?.proto || 'VNC');
  const ip = String(payload.ip ?? current?.ip ?? '').trim();

  if (!isValidHost(ip)) {
    throw new Error('Invalid IP/hostname');
  }

  const port = parsePort(payload.port, current?.port || defaultPortByProto(proto));
  if (!port) {
    throw new Error('Invalid port');
  }

  const nameRaw = String(payload.name ?? current?.name ?? '').trim();
  const name = nameRaw || ip;
  const user = String(payload.user ?? current?.user ?? '').trim();
  const pass = String(payload.pass ?? current?.pass ?? '');
  const privateKey = String(payload.privateKey ?? current?.privateKey ?? '').trim();
  const domain = String(payload.domain ?? current?.domain ?? '').trim();
  const authMode = String(payload.authMode ?? current?.authMode ?? 'local').trim().toLowerCase() === 'domain'
    ? 'domain'
    : 'local';

  return {
    id: current?.id || crypto.randomUUID(),
    name,
    ip,
    port,
    proto,
    user,
    pass,
    privateKey,
    domain,
    authMode,
    createdAt: current?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

async function ensureDataFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  if (!fs.existsSync(TARGETS_FILE)) {
    await fsp.writeFile(TARGETS_FILE, '[]\n', 'utf8');
  }

  if (!fs.existsSync(TOKENS_FILE)) {
    await fsp.writeFile(TOKENS_FILE, '', 'utf8');
  }
}

async function readTargets() {
  const raw = await fsp.readFile(TARGETS_FILE, 'utf8');
  const parsed = safeJsonParse(raw, []);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed;
}

async function safeWriteFile(filePath, content, encoding = 'utf8') {
  const tempPath = `${filePath}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, encoding);
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    try { await fsp.unlink(tempPath); } catch {}
    throw error;
  }
}

async function writeTargets(targets) {
  await safeWriteFile(TARGETS_FILE, `${JSON.stringify(targets, null, 2)}\n`);
}

async function writeTokenFile() {
  const lines = [];

  for (const [token, session] of vncSessions.entries()) {
    lines.push(`${token}: ${session.host}:${session.port}`);
  }

  await safeWriteFile(TOKENS_FILE, lines.length ? `${lines.join('\n')}\n` : '');
}

function cleanupExpiredTokens() {
  const timestamp = Date.now();
  let changed = false;

  for (const [token, session] of vncSessions.entries()) {
    if (session.expiresAt <= timestamp) {
      vncSessions.delete(token);
      changed = true;
    }
  }

  if (changed) {
    writeTokenFile().catch((error) => {
      console.error('Failed to update token file after cleanup:', error);
    });
  }
}

function cleanupExpiredSshSessions() {
  const timestamp = Date.now();
  let count = 0;

  for (const [token, session] of sshSessions.entries()) {
    if (session.expiresAt <= timestamp) {
      sshSessions.delete(token);
      count++;
    }
  }
  if (count > 0) {
    console.info(`[CLEANUP] Removed ${count} expired SSH sessions`);
  }
}

function cleanupExpiredRdpSessions() {
  const timestamp = Date.now();
  let count = 0;

  for (const [token, session] of rdpSessions.entries()) {
    if (session.expiresAt <= timestamp) {
      rdpSessions.delete(token);
      count++;
    }
  }

  if (count > 0) {
    console.info(`[CLEANUP] Removed ${count} expired RDP sessions`);
  }
}

app.use(morgan('combined'));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser(APP_SECRET));

function checkAuth(req, res, next) {
  const publicPaths = ['/api/login', '/login.html', '/login.js', '/style.css'];
  const publicPrefixes = ['/vendor/', '/assets/'];

  if (publicPaths.includes(req.path) || publicPrefixes.some(p => req.path.startsWith(p))) {
    return next();
  }

  const sessionToken = req.signedCookies.session_token;
  if (sessionToken === 'authenticated') {
    // Refresh / slide the session cookie
    res.cookie('session_token', 'authenticated', {
      httpOnly: true,
      signed: true,
      maxAge: SESSION_TTL_MS,
      sameSite: 'lax',
      path: '/',
    });
    return next();
  }

  if (req.path.startsWith('/api/')) {
    console.warn(`[AUTH] Unauthorized API request to ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.info(`[AUTH] Redirecting unauthorized request ${req.path} to login`);
  res.redirect('/login.html');
}

app.use(checkAuth);

const websockifyProxy = createProxyMiddleware({
  target: WEBSOCKIFY_TARGET,
  changeOrigin: true,
  ws: true,
  pathRewrite: {
    '^/websockify': '/',
  },
  logLevel: 'warn',
});

app.use('/websockify', websockifyProxy);

const xtermPackageRoot = path.dirname(require.resolve('@xterm/xterm/package.json'));
const xtermFitPackageRoot = path.dirname(require.resolve('@xterm/addon-fit/package.json'));
const fontAwesomePackageRoot = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));

app.use('/vendor/xterm', express.static(xtermPackageRoot));
app.use('/vendor/xterm-addon-fit', express.static(xtermFitPackageRoot));
app.use('/vendor/fontawesome', express.static(fontAwesomePackageRoot));
app.use('/novnc', express.static(path.join(__dirname, 'novnc')));
app.use('/ssh', express.static(path.join(__dirname, 'public', 'ssh')));
app.use('/rdp', express.static(path.join(__dirname, 'public', 'rdp')));
app.use('/vendor/guacamole', express.static(path.join(__dirname, 'node_modules', 'guacamole-common-js', 'dist', 'cjs')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body;

  if (user === APP_USER && pass === APP_PASS) {
    console.info(`[AUTH] Login successful for user: ${user}`);
    res.cookie('session_token', 'authenticated', {
      httpOnly: true,
      signed: true,
      maxAge: SESSION_TTL_MS,
      sameSite: 'lax',
      path: '/',
    });
    return res.json({ status: 'ok' });
  }

  console.warn(`[AUTH] Login failed for user: ${user}`);

  res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session_token');
  res.json({ status: 'ok' });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    websockify: WEBSOCKIFY_TARGET,
    guacd: `${GUACD_HOST}:${GUACD_PORT}`,
    activeVncSessions: vncSessions.size,
    activeRdpSessions: rdpSessions.size,
    timestamp: nowIso(),
  });
});

app.get('/api/rdp/connect/:token', (req, res) => {
  const sessionToken = String(req.params.token || '').trim();
  const session = rdpSessions.get(sessionToken);

  if (!session || session.expiresAt <= Date.now()) {
    if (session) {
      rdpSessions.delete(sessionToken);
    }

    res.status(404).json({ error: 'RDP session not found or expired' });
    return;
  }

  try {
    const width = parseBoundedInteger(req.query.width, 1280, 640, 3840);
    const height = parseBoundedInteger(req.query.height, 800, 480, 2160);
    const connectionToken = buildRdpConnectionToken(
      {
        ...session,
        width,
        height,
      },
      GUACD_HOST,
      GUACD_PORT,
    );
    const guacToken = encryptGuacamoleToken(connectionToken, GUACAMOLE_CRYPT_KEY);

    res.json({
      wsPath: '/ws/guacamole',
      guacToken,
      width,
      height,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to prepare RDP session' });
  }
});

app.get('/api/targets', async (_req, res) => {
  const targets = await readTargets();
  targets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  res.json(targets);
});

app.post('/api/targets', async (req, res) => {
  try {
    const targets = await readTargets();
    const next = normalizeTargetPayload(req.body);

    targets.push(next);
    await writeTargets(targets);

    res.status(201).json(next);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to create target' });
  }
});

app.put('/api/targets/:id', async (req, res) => {
  try {
    const targets = await readTargets();
    const index = targets.findIndex((entry) => entry.id === req.params.id);

    if (index === -1) {
      res.status(404).json({ error: 'Target not found' });
      return;
    }

    const updated = normalizeTargetPayload(req.body, targets[index]);
    targets[index] = updated;

    await writeTargets(targets);
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to update target' });
  }
});

app.delete('/api/targets/:id', async (req, res) => {
  const targets = await readTargets();
  const next = targets.filter((entry) => entry.id !== req.params.id);

  if (next.length === targets.length) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  await writeTargets(next);
  res.status(204).send();
});

app.get('/api/targets/export', async (_req, res) => {
  const targets = await readTargets();

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="jump-targets-${Date.now()}.json"`);
  res.json({
    exportedAt: nowIso(),
    count: targets.length,
    targets,
  });
});

app.post('/api/targets/import', async (req, res) => {
  try {
    const replace = req.body?.replace !== false;
    const payloadTargets = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.targets)
        ? req.body.targets
        : null;

    if (!payloadTargets) {
      res.status(400).json({ error: 'targets array is required' });
      return;
    }

    const parsedTargets = payloadTargets.map((entry) => {
      const candidate = normalizeTargetPayload(entry);
      return {
        ...candidate,
        id: String(entry.id || candidate.id),
      };
    });

    const deduped = [];
    const keySet = new Set();

    for (const item of parsedTargets) {
      const key = `${item.proto}|${item.ip}|${item.port}`;
      if (!keySet.has(key)) {
        keySet.add(key);
        deduped.push(item);
      }
    }

    const current = await readTargets();
    let next = deduped;

    if (!replace) {
      const mapByKey = new Map();

      for (const item of current) {
        mapByKey.set(`${item.proto}|${item.ip}|${item.port}`, item);
      }

      for (const item of deduped) {
        mapByKey.set(`${item.proto}|${item.ip}|${item.port}`, item);
      }

      next = Array.from(mapByKey.values());
    }

    await writeTargets(next);

    res.json({
      imported: deduped.length,
      total: next.length,
      replace,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to import targets' });
  }
});

app.post('/api/session', async (req, res) => {
  try {
    const proto = normalizeProto(req.body?.proto, 'VNC');
    const host = String(req.body?.ip || '').trim();

    if (!isValidHost(host)) {
      res.status(400).json({ error: 'Invalid IP/hostname' });
      return;
    }

    const port = parsePort(req.body?.port, defaultPortByProto(proto));
    if (!port) {
      res.status(400).json({ error: 'Invalid port' });
      return;
    }

    if (proto !== 'VNC') {
      if (proto === 'SSH') {
        const token = crypto.randomBytes(18).toString('hex');
        sshSessions.set(token, {
          host,
          port,
          username: String(req.body?.user || '').trim(),
          password: String(req.body?.pass || ''),
          privateKey: String(req.body?.privateKey || '').trim(),
          createdAt: Date.now(),
          expiresAt: Date.now() + TOKEN_TTL_MS,
        });
        res.json({ token, proto, host, port });
        return;
      }

      if (proto === 'RDP') {
        const username = String(req.body?.user || '').trim();
        const password = String(req.body?.pass || '');

        if (!username) {
          res.status(400).json({ error: 'Username is required for RDP' });
          return;
        }

        if (!password) {
          res.status(400).json({ error: 'Password is required for RDP' });
          return;
        }

        const token = crypto.randomBytes(18).toString('hex');
        rdpSessions.set(token, {
          host,
          port,
          user: username,
          password,
          domain: String(req.body?.domain || '').trim(),
          authMode: String(req.body?.authMode || 'local').toLowerCase() === 'domain' ? 'domain' : 'local',
          security: String(req.body?.security || 'any').trim() || 'any',
          createdAt: Date.now(),
          expiresAt: Date.now() + TOKEN_TTL_MS,
        });
        res.json({ token, proto, host, port });
        return;
      }

      res.json({ token: null, proto, host, port });
      return;
    }

    const token = crypto.randomBytes(18).toString('hex');

    vncSessions.set(token, {
      host,
      port,
      createdAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    await writeTokenFile();

    res.json({
      token,
      proto,
      host,
      port,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to create session' });
  }
});

app.delete('/api/session/:token', async (req, res) => {
  const token = req.params.token;
  const removedVnc = vncSessions.delete(token);
  const removedSsh = sshSessions.delete(token);
  const removedRdp = rdpSessions.delete(token);

  if (removedVnc) {
    await writeTokenFile();
  }

  res.status(removedVnc || removedSsh || removedRdp ? 204 : 404).send();
});

const sshWss = new WebSocketServer({ noServer: true });

sshWss.on('connection', (ws, req) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = requestUrl.searchParams.get('token');
  let sessionData = null;

  if (token && sshSessions.has(token)) {
    sessionData = sshSessions.get(token);
  }

  const host = sessionData
    ? sessionData.host
    : String(requestUrl.searchParams.get('host') || '').trim();
  const username = sessionData
    ? sessionData.username
    : String(requestUrl.searchParams.get('username') || '').trim();
  const password = sessionData
    ? sessionData.password
    : String(requestUrl.searchParams.get('password') || '');
  const privateKey = sessionData
    ? sessionData.privateKey
    : String(requestUrl.searchParams.get('privateKey') || '').trim();
  const port = sessionData
    ? sessionData.port
    : parsePort(requestUrl.searchParams.get('port'), 22);
  const defaultIdleTimeoutMs = parseBoundedInteger(
    SSH_DEFAULT_IDLE_TIMEOUT_MS,
    15 * 60 * 1000,
    SSH_MIN_IDLE_TIMEOUT_MS,
    SSH_MAX_IDLE_TIMEOUT_MS,
  );
  const idleTimeoutMs = parseBoundedInteger(
    requestUrl.searchParams.get('idleTimeoutMs'),
    sessionData ? 15 * 60 * 1000 : defaultIdleTimeoutMs,
    SSH_MIN_IDLE_TIMEOUT_MS,
    SSH_MAX_IDLE_TIMEOUT_MS,
  );

  if (!isValidHost(host) || !port || !username) {
    ws.send(JSON.stringify({ type: 'error', message: 'host, port, username are required' }));
    ws.close();
    return;
  }

  const ssh = new SshClient();
  let shellStream = null;
  let sawKeyboardInteractive = false;
  let idleTimer = null;
  let wsKeepAliveTimer = null;
  let closed = false;
  let pendingResize = { cols: 120, rows: 35 };

  const resetIdleTimer = () => {
    if (closed) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'status', state: 'idle-timeout', idleTimeoutMs }));
        ws.close(4000, 'idle timeout');
      }

      cleanup();
    }, idleTimeoutMs);
  };

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (wsKeepAliveTimer) {
      clearInterval(wsKeepAliveTimer);
      wsKeepAliveTimer = null;
    }

    try {
      if (shellStream) {
        shellStream.end();
      }
    } catch {
      // Ignore cleanup errors
    }

    ssh.end();
  };

  wsKeepAliveTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30000);

  resetIdleTimer();

  ssh.on('ready', () => {
    ssh.shell({ term: 'xterm-256color', cols: pendingResize.cols, rows: pendingResize.rows }, (error, stream) => {
      if (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
        ws.close();
        return;
      }

      shellStream = stream;
      shellStream.setWindow(pendingResize.rows, pendingResize.cols, 0, 0);
      ws.send(JSON.stringify({ type: 'status', state: 'ready', idleTimeoutMs }));

      stream.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: chunk.toString('utf8') }));
          resetIdleTimer();
        }
      });

      stream.on('close', () => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'status', state: 'closed' }));
          ws.close();
        }
      });
    });
  });

  // Provide immediate feedback to avoid the blank screen
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'data', data: '\r\n[SSH] Connecting to host ' + host + '... please wait...\r\n' }));
  }

  ssh.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
    sawKeyboardInteractive = true;

    if (!Array.isArray(prompts) || prompts.length === 0) {
      finish([]);
      return;
    }

    // Some SSH servers prompt multiple times (password/passcode/OTP).
    // We currently reuse the supplied password for every challenge slot.
    const responses = prompts.map(() => password || '');
    finish(responses);
  });

  ssh.on('error', (error) => {
    if (ws.readyState === ws.OPEN) {
      let message = error.message || 'SSH connection error';

      if (message.includes('All configured authentication methods failed')) {
        if (privateKey) {
          message = password
            ? 'Authentication failed: Invalid private key or passphrase.'
            : 'Authentication failed: Invalid private key. Use Password field for key passphrase if needed.';
        } else if (!password) {
          message = 'Authentication failed: Provide password or private key.';
        } else if (sawKeyboardInteractive) {
          message = 'Authentication failed: Invalid username or password (Keyboard-interactive).';
        } else {
          message = 'Authentication failed: Invalid username or password. Please check your credentials.';
        }
      }

      ws.send(JSON.stringify({ type: 'error', message }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let payload = null;

    try {
      payload = JSON.parse(raw.toString());
    } catch {
      payload = { type: 'input', data: raw.toString() };
    }

    if (payload.type === 'ping') {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'pong' }));
      }

      resetIdleTimer();
      return;
    }

    if (payload.type === 'input') {
      if (!shellStream) {
        return;
      }

      shellStream.write(String(payload.data || ''));
      resetIdleTimer();
      return;
    }

    if (payload.type === 'resize') {
      const cols = Number.parseInt(String(payload.cols || ''), 10) || 120;
      const rows = Number.parseInt(String(payload.rows || ''), 10) || 35;
      pendingResize = { cols, rows };

      if (shellStream) {
        shellStream.setWindow(rows, cols, 0, 0);
      }

      resetIdleTimer();
    }
  });

  ws.on('close', cleanup);

  const connectOptions = {
    host,
    port,
    username,
    tryKeyboard: true,
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
  };

  if (privateKey) {
    connectOptions.privateKey = privateKey;
    if (password) {
      connectOptions.passphrase = password;
    }
  } else {
    connectOptions.password = password;
  }

  ssh.connect(connectOptions);
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

  // Basic cookie check for WebSocket upgrade
  cookieParser(APP_SECRET)(req, {}, () => {
    const sessionToken = req.signedCookies?.session_token;
    if (sessionToken !== 'authenticated') {
      console.warn(`[AUTH] WebSocket upgrade denied: invalid session cookie for ${pathname}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    proceedUpgrade(req, socket, head, pathname);
  });
});

function proceedUpgrade(req, socket, head, pathname) {

  if (pathname === '/ws/ssh') {
    sshWss.handleUpgrade(req, socket, head, (ws) => {
      sshWss.emit('connection', ws, req);
    });
    return;
  }

  if (pathname.startsWith('/websockify')) {
    websockifyProxy.upgrade(req, socket, head);
    return;
  }

  if (pathname === '/ws/guacamole') {
    guacamoleWsProxy.upgrade(req, socket, head);
    return;
  }

  socket.destroy();
}

let guacamoleServer = null;
let guacamoleWsProxy = null;

function startGuacamoleBridge() {
  guacamoleServer = new GuacamoleLite(
    { port: GUACAMOLE_WS_PORT },
    { host: GUACD_HOST, port: GUACD_PORT },
    {
      crypt: {
        cypher: 'AES-256-CBC',
        key: getGuacamoleCryptKey(GUACAMOLE_CRYPT_KEY),
      },
      connectionDefaultSettings: {
        rdp: {
          port: '3389',
          security: 'any',
          'ignore-cert': true,
          'enable-wallpaper': false,
          'resize-method': 'display-update',
        },
      },
    },
  );

  guacamoleWsProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${GUACAMOLE_WS_PORT}`,
    ws: true,
    changeOrigin: true,
    pathRewrite: {
      '^/ws/guacamole': '/',
    },
  });

  console.info(`[RDP] guacamole-lite websocket on 127.0.0.1:${GUACAMOLE_WS_PORT} -> guacd ${GUACD_HOST}:${GUACD_PORT}`);
}

async function boot() {
  await ensureDataFiles();
  await writeTokenFile();
  startGuacamoleBridge();

  setInterval(() => {
    cleanupExpiredTokens();
    cleanupExpiredSshSessions();
    cleanupExpiredRdpSessions();
  }, 30 * 1000);

  server.listen(PORT, () => {
    console.log(`jump-access listening on http://0.0.0.0:${PORT}`);
    console.log(`websockify proxy target: ${WEBSOCKIFY_TARGET}`);
    console.log(`data directory: ${DATA_DIR}`);
  });
}

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});
