const { findById, sanitizeUser } = require('./users');

function parseSessionCookie(raw) {
  if (!raw) {
    return null;
  }

  if (raw === 'authenticated') {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.id || !parsed?.username || !parsed?.role) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function buildSessionPayload(user) {
  return JSON.stringify({
    id: user.id,
    username: user.username,
    role: user.role,
  });
}

async function loadRequestUser(sessionCookie) {
  const session = parseSessionCookie(sessionCookie);
  if (!session) {
    return null;
  }

  const user = await findById(session.id);
  if (!user || user.active === false) {
    return null;
  }

  if (user.username !== session.username || user.role !== session.role) {
    return null;
  }

  return sanitizeUser(user);
}

function setSessionCookie(res, user, { secret, maxAge }) {
  res.cookie('session_token', buildSessionPayload(user), {
    httpOnly: true,
    signed: true,
    maxAge,
    sameSite: 'lax',
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie('session_token');
}

module.exports = {
  parseSessionCookie,
  buildSessionPayload,
  loadRequestUser,
  setSessionCookie,
  clearSessionCookie,
};
