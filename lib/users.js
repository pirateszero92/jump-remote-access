const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { normalizeRole, ROLES } = require('./permissions');
const { normalizeThemeId } = require('./themes');

let usersFilePath = path.join(__dirname, '..', 'data', 'users.json');

function configureUsersStore(dataDir) {
  usersFilePath = path.join(dataDir, 'users.json');
}

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !String(password)) {
    return false;
  }

  const [salt, expected] = String(storedHash).split(':');
  if (!salt || !expected) {
    return false;
  }

  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  } catch {
    return false;
  }
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName || user.username,
    theme: normalizeThemeId(user.theme),
    assignedTargetIds: Array.isArray(user.assignedTargetIds) ? [...user.assignedTargetIds] : [],
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function readStore() {
  try {
    const raw = await fsp.readFile(usersFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function writeStore(users) {
  await fsp.mkdir(path.dirname(usersFilePath), { recursive: true });
  const tempPath = `${usersFilePath}.tmp`;
  const payload = `${JSON.stringify({ users }, null, 2)}\n`;

  await fsp.writeFile(tempPath, payload, 'utf8');
  await fsp.rename(tempPath, usersFilePath);
}

async function ensureUsersFile(bootstrapUser, bootstrapPass) {
  await fsp.mkdir(path.dirname(usersFilePath), { recursive: true });

  if (fs.existsSync(usersFilePath)) {
    return;
  }

  const username = String(bootstrapUser || 'admin').trim() || 'admin';
  const password = String(bootstrapPass || 'password');

  const users = [
    {
      id: crypto.randomUUID(),
      username,
      passwordHash: hashPassword(password),
      role: ROLES.SUPERADMIN,
      displayName: 'Super Admin',
      theme: 'default',
      assignedTargetIds: [],
      active: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ];

  await writeStore(users);
  console.info(`[AUTH] Created default superadmin user "${username}" in users.json`);
}

async function findByUsername(username) {
  const users = await readStore();
  const needle = String(username || '').trim().toLowerCase();
  return users.find((entry) => entry.username.toLowerCase() === needle) || null;
}

async function findById(userId) {
  const users = await readStore();
  return users.find((entry) => entry.id === userId) || null;
}

async function listUsers() {
  const users = await readStore();
  return users
    .map(sanitizeUser)
    .sort((a, b) => String(a.username).localeCompare(String(b.username)));
}

async function authenticate(username, password) {
  const user = await findByUsername(username);
  if (!user || user.active === false) {
    return null;
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return null;
  }

  return sanitizeUser(user);
}

async function createUser(payload) {
  const users = await readStore();
  const username = String(payload.username || '').trim();

  if (!username || username.length < 2) {
    throw new Error('Username must be at least 2 characters');
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new Error('Username may only contain letters, numbers, . _ -');
  }

  if (users.some((entry) => entry.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('Username already exists');
  }

  const role = normalizeRole(payload.role);
  if (!role) {
    throw new Error('Invalid role');
  }

  const password = String(payload.password || '');
  if (password.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }

  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    role,
    displayName: String(payload.displayName || username).trim() || username,
    theme: normalizeThemeId(payload.theme),
    assignedTargetIds: Array.isArray(payload.assignedTargetIds)
      ? payload.assignedTargetIds.map(String)
      : [],
    active: payload.active !== false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  users.push(user);
  await writeStore(users);
  return sanitizeUser(user);
}

async function updateUser(userId, payload) {
  const users = await readStore();
  const index = users.findIndex((entry) => entry.id === userId);

  if (index === -1) {
    throw new Error('User not found');
  }

  const current = users[index];

  if (payload.displayName !== undefined) {
    current.displayName = String(payload.displayName || current.username).trim() || current.username;
  }

  if (payload.theme !== undefined) {
    current.theme = normalizeThemeId(payload.theme);
  }

  if (payload.assignedTargetIds !== undefined) {
    current.assignedTargetIds = Array.isArray(payload.assignedTargetIds)
      ? payload.assignedTargetIds.map(String)
      : [];
  }

  if (payload.active !== undefined) {
    current.active = Boolean(payload.active);
  }

  if (payload.role !== undefined) {
    const role = normalizeRole(payload.role);
    if (!role) {
      throw new Error('Invalid role');
    }

    current.role = role;
  }

  if (payload.password !== undefined && String(payload.password).length > 0) {
    if (String(payload.password).length < 4) {
      throw new Error('Password must be at least 4 characters');
    }

    current.passwordHash = hashPassword(String(payload.password));
  }

  current.updatedAt = nowIso();
  users[index] = current;
  await writeStore(users);
  return sanitizeUser(current);
}

async function deleteUser(userId) {
  const users = await readStore();
  const target = users.find((entry) => entry.id === userId);

  if (!target) {
    throw new Error('User not found');
  }

  const superadminCount = users.filter((entry) => entry.role === ROLES.SUPERADMIN && entry.active !== false).length;
  if (target.role === ROLES.SUPERADMIN && superadminCount <= 1) {
    throw new Error('Cannot delete the last active superadmin');
  }

  const next = users.filter((entry) => entry.id !== userId);
  await writeStore(next);
  return sanitizeUser(target);
}

module.exports = {
  configureUsersStore,
  hashPassword,
  verifyPassword,
  sanitizeUser,
  ensureUsersFile,
  findByUsername,
  findById,
  listUsers,
  authenticate,
  createUser,
  updateUser,
  deleteUser,
};
