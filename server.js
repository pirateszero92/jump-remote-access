require('dotenv').config();

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
const {
  createRecorder,
  findSession,
  getReport,
  readSessionFile,
} = require('./lib/ssh-recorder');
const {
  loadRequestUser,
  setSessionCookie,
  clearSessionCookie,
} = require('./lib/auth-session');
const {
  configureUsersStore,
  ensureUsersFile,
  listUsers,
  authenticate,
  createUser,
  updateUser,
  deleteUser,
  findById,
} = require('./lib/users');
const { listThemes, normalizeThemeId } = require('./lib/themes');
const {
  ROLES,
  canViewReports,
  canManageUsers,
  canManageTarget,
  actorCanManageUser,
  actorCanAssignRole,
  filterTargetsForUser,
  userCanAccessTarget,
  findTargetForSession,
} = require('./lib/permissions');
const { getSnmpMetrics, getExporterMetrics } = require('./lib/monitor');

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
const SSH_RECORD_ENABLED = String(process.env.SSH_RECORD_ENABLED || 'true').toLowerCase() !== 'false';
const SSH_RECORD_DIR = process.env.SSH_RECORD_DIR || path.join(DATA_DIR, 'ssh-recordings');

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
  configureUsersStore(DATA_DIR);
  await ensureUsersFile(APP_USER, APP_PASS);

  if (!fs.existsSync(TARGETS_FILE)) {
    await fsp.writeFile(TARGETS_FILE, '[]\n', 'utf8');
  }

  if (!fs.existsSync(TOKENS_FILE)) {
    await fsp.writeFile(TOKENS_FILE, '', 'utf8');
  }
}

async function assertCanStartSession(user, body) {
  const proto = normalizeProto(body?.proto, 'VNC');
  const host = String(body?.ip || '').trim();
  const port = parsePort(body?.port, defaultPortByProto(proto));

  if (!isValidHost(host) || !port) {
    throw new Error('Invalid host or port');
  }

  if (user.role === ROLES.SUPERADMIN || user.role === ROLES.ADMIN) {
    return { proto, host, port };
  }

  const targets = await readTargets();
  const visible = filterTargetsForUser(targets, user);
  const target = findTargetForSession(visible, {
    targetId: body?.targetId,
    ip: host,
    port,
    proto,
  });

  if (!target) {
    throw new Error('You are not allowed to connect to this target');
  }

  return { proto, host, port, target };
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



const PUBLIC_PATHS = new Set([
  '/api/login',
  '/login.html',
  '/login.js',
  '/style.css',
  '/themes.css',
  '/theme.js',
]);

const PUBLIC_PREFIXES = ['/vendor/', '/assets/', '/admin/admin.css'];

function isPublicRequest(req) {
  return PUBLIC_PATHS.has(req.path) || PUBLIC_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}

async function attachUser(req, res, next) {
  if (isPublicRequest(req)) {
    return next();
  }

  const user = await loadRequestUser(req.signedCookies?.session_token);
  if (!user) {
    if (req.path.startsWith('/api/')) {
      console.warn(`[AUTH] Unauthorized API request to ${req.path} from ${req.ip}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.info(`[AUTH] Redirecting unauthorized request ${req.path} to login`);
    return res.redirect('/login.html');
  }

  req.user = user;
  setSessionCookie(res, user, { maxAge: SESSION_TTL_MS });
  return next();
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
}

app.use((req, res, next) => {
  attachUser(req, res, next).catch(next);
});

app.get('/api/monitor/metrics', async (req, res) => {
  try {
    const host = String(req.query.host).trim();
    const type = String(req.query.type).trim();
    const community = String(req.query.community).trim() || 'public';
    const port = parseInt(req.query.port) || (type === 'snmp' ? 161 : 9100);

    if (!host) {
      return res.status(400).json({ error: 'host is required' });
    }

    let metrics;
    if (type === 'snmp') {
      metrics = await getSnmpMetrics(host, community, port);
    } else if (type === 'exporter') {
      metrics = await getExporterMetrics(host, port);
    } else {
      return res.status(400).json({ error: 'Invalid monitor type. Use snmp or exporter.' });
    }

    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/reports.html', (req, res) => {
  if (!req.user) {
    res.redirect('/login.html');
    return;
  }

  if (!canViewReports(req.user)) {
    res.status(403).send('Forbidden: reports are superadmin only');
    return;
  }

  res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});

app.get('/admin/users.html', (req, res) => {
  if (!req.user) {
    res.redirect('/login.html');
    return;
  }

  if (!canManageUsers(req.user)) {
    res.redirect('/');
    return;
  }

  res.sendFile(path.join(__dirname, 'public', 'admin', 'users.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.user || '').trim();
  const password = String(req.body?.pass || '');

  try {
    const user = await authenticate(username, password);
    if (!user) {
      console.warn(`[AUTH] Login failed for user: ${username}`);
      res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
      return;
    }

    console.info(`[AUTH] Login successful for user: ${user.username} (${user.role})`);
    setSessionCookie(res, user, { maxAge: SESSION_TTL_MS });
    res.json({
      status: 'ok',
      user: {
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        theme: user.theme,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ status: 'ok' });
});

app.get('/api/me', (req, res) => {
  res.json({
    ...req.user,
    permissions: {
      reports: canViewReports(req.user),
      manageUsers: canManageUsers(req.user),
      manageTargets: canManageTarget(req.user),
    },
  });
});

app.get('/api/themes', (_req, res) => {
  res.json(listThemes());
});

app.put('/api/me/theme', async (req, res) => {
  try {
    const theme = normalizeThemeId(req.body?.theme);
    const updated = await updateUser(req.user.id, { theme });
    res.json({ theme: updated.theme });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to update theme' });
  }
});

app.get('/api/users', requireRoles(ROLES.SUPERADMIN, ROLES.ADMIN), async (_req, res) => {
  const users = await listUsers();
  res.json(users);
});

app.post('/api/users', requireRoles(ROLES.SUPERADMIN, ROLES.ADMIN), async (req, res) => {
  try {
    if (!actorCanAssignRole(req.user, req.body?.role)) {
      res.status(403).json({ error: 'Forbidden role assignment' });
      return;
    }

    const user = await createUser(req.body);
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to create user' });
  }
});

app.put('/api/users/:id', requireRoles(ROLES.SUPERADMIN, ROLES.ADMIN), async (req, res) => {
  try {
    const target = await findById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!actorCanManageUser(req.user, target)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (req.body?.role !== undefined && !actorCanAssignRole(req.user, req.body.role)) {
      res.status(403).json({ error: 'Forbidden role assignment' });
      return;
    }

    const user = await updateUser(req.params.id, req.body);
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to update user' });
  }
});

app.delete('/api/users/:id', requireRoles(ROLES.SUPERADMIN, ROLES.ADMIN), async (req, res) => {
  try {
    const target = await findById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!actorCanManageUser(req.user, target)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (target.id === req.user.id) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    await deleteUser(req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to delete user' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    websockify: WEBSOCKIFY_TARGET,
    guacd: `${GUACD_HOST}:${GUACD_PORT}`,
    activeVncSessions: vncSessions.size,
    activeRdpSessions: rdpSessions.size,
    sshRecordingEnabled: SSH_RECORD_ENABLED,
    sshRecordDir: SSH_RECORD_DIR,
    timestamp: nowIso(),
  });
});

app.get('/api/ssh-recordings/report', requireRoles(ROLES.SUPERADMIN), async (req, res) => {
  try {
    const now = new Date();
    const year = parseBoundedInteger(req.query.year, now.getFullYear(), 2020, 2100);
    const month = req.query.month === undefined || req.query.month === ''
      ? null
      : parseBoundedInteger(req.query.month, now.getMonth() + 1, 1, 12);

    const report = await getReport(SSH_RECORD_DIR, year, month);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load SSH recording report' });
  }
});

app.get('/api/ssh-recordings/:sessionId', requireRoles(ROLES.SUPERADMIN), async (req, res) => {
  try {
    const found = await findSession(SSH_RECORD_DIR, String(req.params.sessionId || '').trim());
    if (!found) {
      res.status(404).json({ error: 'Recording not found' });
      return;
    }

    res.json(found.meta);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load recording metadata' });
  }
});

app.get('/api/ssh-recordings/:sessionId/cast', requireRoles(ROLES.SUPERADMIN), async (req, res) => {
  try {
    const payload = await readSessionFile(
      SSH_RECORD_DIR,
      String(req.params.sessionId || '').trim(),
      'session.cast',
    );

    if (!payload) {
      res.status(404).json({ error: 'Recording cast not found' });
      return;
    }

    res.type('application/x-ndjson').send(payload.raw);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load session cast' });
  }
});

app.get('/api/ssh-recordings/:sessionId/keys', requireRoles(ROLES.SUPERADMIN), async (req, res) => {
  try {
    const payload = await readSessionFile(
      SSH_RECORD_DIR,
      String(req.params.sessionId || '').trim(),
      'keys.jsonl',
    );

    if (!payload) {
      res.status(404).json({ error: 'Keystroke log not found' });
      return;
    }

    const lines = payload.raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { t: 0, keys: line, parseError: true };
        }
      });

    res.json({ sessionId: payload.meta.id, entries: lines });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load keystroke log' });
  }
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

app.get('/api/targets', async (req, res) => {
  const targets = await readTargets();
  const visible = filterTargetsForUser(targets, req.user);
  visible.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  res.json(visible);
});

app.post('/api/targets', async (req, res) => {
  if (!canManageTarget(req.user)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

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
  if (!canManageTarget(req.user)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

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
  if (!canManageTarget(req.user)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const targets = await readTargets();
  const next = targets.filter((entry) => entry.id !== req.params.id);

  if (next.length === targets.length) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  await writeTargets(next);
  res.status(204).send();
});

app.get('/api/targets/export', async (req, res) => {
  if (!canManageTarget(req.user)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

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
  if (!canManageTarget(req.user)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

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
    const allowed = await assertCanStartSession(req.user, req.body);
    const proto = allowed.proto;
    const host = allowed.host;
    const port = allowed.port;

    if (proto !== 'VNC') {
      if (proto === 'SSH') {
        const token = crypto.randomBytes(18).toString('hex');
        const username = String(req.body?.user || '').trim();
        const label = String(req.body?.label || '').trim() || `${username}@${host}`;

        sshSessions.set(token, {
          host,
          port,
          username,
          label,
          password: String(req.body?.pass || ''),
          privateKey: String(req.body?.privateKey || '').trim(),
          jumpUser: req.user.username,
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

function getSshParamsFromRequest(req) {
  const token = req.query.token || req.headers['x-jump-token'];
  let sessionData = null;
  if (token && sshSessions.has(token)) {
    sessionData = sshSessions.get(token);
  }
  const host = sessionData ? sessionData.host : String(req.query.host || '').trim();
  const username = sessionData ? sessionData.username : String(req.query.username || '').trim();
  const password = sessionData ? sessionData.password : String(req.query.password || '');
  const privateKey = sessionData ? sessionData.privateKey : String(req.query.privateKey || '').trim();
  const port = sessionData ? sessionData.port : parsePort(req.query.port, 22);

  if (!isValidHost(host) || !port || !username) {
    return null;
  }

  const connectOptions = {
    host,
    port,
    username,
    readyTimeout: SSH_READY_TIMEOUT_MS,
  };
  if (privateKey) {
    connectOptions.privateKey = privateKey;
    if (password) {
      connectOptions.passphrase = password;
    }
  } else {
    connectOptions.password = password;
  }
  return connectOptions;
}

app.get('/api/ssh/sftp/download', (req, res) => {
  const connectOptions = getSshParamsFromRequest(req);
  const remotePath = String(req.query.remotePath || '').trim();
  const isDir = req.query.isDir === 'true';
  
  if (!connectOptions) {
    res.status(400).json({ error: 'host, port, username are required' });
    return;
  }
  if (!remotePath) {
    res.status(400).json({ error: 'remotePath is required' });
    return;
  }

  const ssh = new SshClient();
  let sftpClosed = false;
  
  const cleanup = () => {
    if (!sftpClosed) {
      sftpClosed = true;
      ssh.end();
    }
  };

  ssh.on('ready', () => {
    if (isDir) {
      // Download directory as tar.gz using SSH exec
      const folderName = remotePath.split('/').pop() || 'folder';
      const filename = folderName + '.tar.gz';
      const dirName = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
      
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', 'application/gzip');
      
      ssh.exec(`tar -czf - -C "${dirName}" "${folderName}"`, (err, stream) => {
        if (err) {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to start tar: ' + err.message });
          }
          cleanup();
          return;
        }
        
        stream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Tar stream error: ' + err.message });
          }
          cleanup();
        });
        
        stream.on('close', cleanup);
        stream.pipe(res);
      });
    } else {
      ssh.sftp((err, sftp) => {
        if (err) {
          res.status(500).json({ error: 'SFTP session failed: ' + err.message });
          cleanup();
          return;
        }
        const filename = remotePath.split('/').pop() || 'download';
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        const readStream = sftp.createReadStream(remotePath);
        readStream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to read file: ' + err.message });
          }
          cleanup();
        });
        readStream.on('close', cleanup);
        readStream.pipe(res);
      });
    }
  });
  
  ssh.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSH connection error: ' + err.message });
    }
    cleanup();
  });
  
  ssh.connect(connectOptions);
});

app.post('/api/ssh/sftp/upload', (req, res) => {
  const connectOptions = getSshParamsFromRequest(req);
  const remotePath = String(req.query.remotePath || req.headers['x-jump-remote-path'] || '').trim();
  
  if (!connectOptions) {
    res.status(400).json({ error: 'host, port, username are required' });
    return;
  }
  if (!remotePath) {
    res.status(400).json({ error: 'remotePath is required' });
    return;
  }

  const ssh = new SshClient();
  let sftpClosed = false;
  
  const cleanup = () => {
    if (!sftpClosed) {
      sftpClosed = true;
      ssh.end();
    }
  };

  ssh.on('ready', () => {
    ssh.sftp((err, sftp) => {
      if (err) {
        res.status(500).json({ error: 'SFTP session failed: ' + err.message });
        cleanup();
        return;
      }
      
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on('error', (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to write file: ' + err.message });
        }
        cleanup();
      });
      writeStream.on('close', () => {
        if (!res.headersSent) {
          res.json({ success: true, path: remotePath });
        }
        cleanup();
      });
      req.pipe(writeStream);
    });
  });
  
  ssh.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSH connection error: ' + err.message });
    }
    cleanup();
  });
  
  ssh.connect(connectOptions);
});

app.get('/api/ssh/sftp/list', (req, res) => {
  const connectOptions = getSshParamsFromRequest(req);
  const remotePath = String(req.query.path || '').trim() || '.';
  
  if (!connectOptions) {
    res.status(400).json({ error: 'host, port, username are required' });
    return;
  }

  const ssh = new SshClient();
  let sftpClosed = false;
  
  const cleanup = () => {
    if (!sftpClosed) {
      sftpClosed = true;
      ssh.end();
    }
  };

  ssh.on('ready', () => {
    ssh.sftp((err, sftp) => {
      if (err) {
        res.status(500).json({ error: 'SFTP session failed: ' + err.message });
        cleanup();
        return;
      }
      
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          res.status(500).json({ error: 'Failed to read directory: ' + err.message });
          cleanup();
          return;
        }

        sftp.realpath(remotePath, (err, absPath) => {
           const finalPath = err ? remotePath : absPath;
           
           const entries = list.map(item => ({
             name: item.filename,
             isDir: item.attrs.isDirectory(),
             isFile: item.attrs.isFile(),
             isSymlink: item.attrs.isSymbolicLink(),
             size: item.attrs.size,
             mtime: item.attrs.mtime
           }));
           
           // Sort directories first
           entries.sort((a, b) => {
             if (a.isDir && !b.isDir) return -1;
             if (!a.isDir && b.isDir) return 1;
             return a.name.localeCompare(b.name);
           });

           res.json({ path: finalPath, entries });
           cleanup();
        });
      });
    });
  });
  
  ssh.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSH connection error: ' + err.message });
    }
    cleanup();
  });
  
  ssh.connect(connectOptions);
});

app.post('/api/ssh/sftp/rename', (req, res) => {
  const connectOptions = getSshParamsFromRequest(req);
  const oldPath = String(req.body.oldPath || '').trim();
  const newPath = String(req.body.newPath || '').trim();
  
  if (!connectOptions || !oldPath || !newPath) {
    res.status(400).json({ error: 'host, port, username, oldPath, and newPath are required' });
    return;
  }

  const ssh = new SshClient();
  let sftpClosed = false;
  
  const cleanup = () => {
    if (!sftpClosed) {
      sftpClosed = true;
      ssh.end();
    }
  };

  ssh.on('ready', () => {
    ssh.sftp((err, sftp) => {
      if (err) {
        res.status(500).json({ error: 'SFTP session failed: ' + err.message });
        cleanup();
        return;
      }
      
      sftp.rename(oldPath, newPath, (err) => {
        if (err) {
          res.status(500).json({ error: 'Failed to rename: ' + err.message });
        } else {
          res.json({ success: true });
        }
        cleanup();
      });
    });
  });
  
  ssh.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSH connection error: ' + err.message });
    }
    cleanup();
  });
  
  ssh.connect(connectOptions);
});

app.delete('/api/ssh/sftp/delete', (req, res) => {
  const connectOptions = getSshParamsFromRequest(req);
  const targetPath = String(req.query.path || '').trim();
  const isDir = String(req.query.isDir) === 'true';
  
  if (!connectOptions || !targetPath) {
    res.status(400).json({ error: 'host, port, username, and path are required' });
    return;
  }

  const ssh = new SshClient();
  let sftpClosed = false;
  
  const cleanup = () => {
    if (!sftpClosed) {
      sftpClosed = true;
      ssh.end();
    }
  };

  ssh.on('ready', () => {
    ssh.sftp((err, sftp) => {
      if (err) {
        res.status(500).json({ error: 'SFTP session failed: ' + err.message });
        cleanup();
        return;
      }
      
      const callback = (err) => {
        if (err) {
          res.status(500).json({ error: 'Failed to delete: ' + err.message });
        } else {
          res.json({ success: true });
        }
        cleanup();
      };

      if (isDir) {
        sftp.rmdir(targetPath, callback);
      } else {
        sftp.unlink(targetPath, callback);
      }
    });
  });
  
  ssh.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'SSH connection error: ' + err.message });
    }
    cleanup();
  });
  
  ssh.connect(connectOptions);
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
  let recorder = null;
  let endReason = 'closed';

  if (SSH_RECORD_ENABLED) {
    recorder = createRecorder({
      enabled: true,
      baseDir: SSH_RECORD_DIR,
      meta: {
        host,
        port,
        username,
        jumpUser: sessionData?.jumpUser,
        label: sessionData?.label || `${username}@${host}`,
        cols: pendingResize.cols,
        rows: pendingResize.rows,
      },
    });
  }

  const resetIdleTimer = () => {
    if (closed) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
      endReason = 'idle-timeout';
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

    if (recorder) {
      const activeRecorder = recorder;
      recorder = null;
      activeRecorder.finalize(endReason).catch((error) => {
        console.error('[SSH-RECORD] Failed to finalize recording:', error.message);
      });
    }
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
        const text = chunk.toString('utf8');
        recorder?.recordOutput(text);

        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: text }));
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
    endReason = 'error';
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

      const input = String(payload.data || '');
      recorder?.recordInput(input);
      shellStream.write(input);
      resetIdleTimer();
      return;
    }

    if (payload.type === 'resize') {
      const cols = Number.parseInt(String(payload.cols || ''), 10) || 120;
      const rows = Number.parseInt(String(payload.rows || ''), 10) || 35;
      pendingResize = { cols, rows };
      recorder?.updateSize(cols, rows);

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
  cookieParser(APP_SECRET)(req, {}, async () => {
    const user = await loadRequestUser(req.signedCookies?.session_token);
    if (!user) {
      console.warn(`[AUTH] WebSocket upgrade denied: invalid session cookie for ${pathname}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    req.user = user;
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
    console.log(`ssh recording: ${SSH_RECORD_ENABLED ? 'enabled' : 'disabled'} (${SSH_RECORD_DIR})`);
  });
}

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});
