const crypto = require('node:crypto');

const CIPHER = 'aes-256-cbc';

function getGuacamoleCryptKey(secret) {
  const raw = String(secret || '');
  if (raw.length === 32) {
    return Buffer.from(raw, 'utf8');
  }

  return crypto.createHash('sha256').update(raw).digest();
}

function encryptGuacamoleToken(tokenObject, secret) {
  const key = getGuacamoleCryptKey(secret);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);

  let encrypted = cipher.update(JSON.stringify(tokenObject), 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const payload = {
    iv: iv.toString('base64'),
    value: encrypted,
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

module.exports = {
  encryptGuacamoleToken,
  getGuacamoleCryptKey,
};
