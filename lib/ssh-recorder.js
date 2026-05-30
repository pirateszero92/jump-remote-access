const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const INDEX_FILE = 'index.json';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function createSessionId(startedAt = new Date()) {
  const stamp = [
    startedAt.getFullYear(),
    pad2(startedAt.getMonth() + 1),
    pad2(startedAt.getDate()),
  ].join('');

  const time = [
    pad2(startedAt.getHours()),
    pad2(startedAt.getMinutes()),
    pad2(startedAt.getSeconds()),
  ].join('');

  return `${stamp}-${time}-${crypto.randomBytes(3).toString('hex')}`;
}

function datePathParts(startedAt = new Date()) {
  return [
    String(startedAt.getFullYear()),
    pad2(startedAt.getMonth() + 1),
    pad2(startedAt.getDate()),
  ];
}

async function readIndex(baseDir) {
  const indexPath = path.join(baseDir, INDEX_FILE);

  try {
    const raw = await fsp.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.sessions) ? parsed : { sessions: [] };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { sessions: [] };
    }

    throw error;
  }
}

async function writeIndex(baseDir, index) {
  await fsp.mkdir(baseDir, { recursive: true });
  const indexPath = path.join(baseDir, INDEX_FILE);
  await fsp.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

function summarizeSession(meta) {
  const startedAt = new Date(meta.startedAt);
  return {
    id: meta.id,
    year: startedAt.getFullYear(),
    month: startedAt.getMonth() + 1,
    day: startedAt.getDate(),
    host: meta.host,
    port: meta.port,
    username: meta.username,
    label: meta.label || `${meta.username}@${meta.host}`,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt || null,
    durationSec: meta.durationSec || 0,
    bytesRecorded: meta.bytesRecorded || 0,
    relativePath: meta.relativePath,
  };
}

class SshSessionRecorder {
  constructor({ baseDir, meta }) {
    this.baseDir = baseDir;
    this.startedAt = new Date();
    this.startedAtMs = this.startedAt.getTime();
    this.sessionId = createSessionId(this.startedAt);
    this.relativePath = path.posix.join(...datePathParts(this.startedAt), this.sessionId);
    this.sessionDir = path.join(baseDir, ...datePathParts(this.startedAt), this.sessionId);
    this.meta = {
      id: this.sessionId,
      host: meta.host,
      port: meta.port,
      username: meta.username,
      label: meta.label || `${meta.username}@${meta.host}`,
      proto: 'SSH',
      startedAt: this.startedAt.toISOString(),
      relativePath: this.relativePath.replace(/\\/g, '/'),
    };
    this.width = meta.cols || 120;
    this.height = meta.rows || 35;
    this.bytesRecorded = 0;
    this.closed = false;
    this.castStream = null;
    this.keysStream = null;
  }

  init() {
    fs.mkdirSync(this.sessionDir, { recursive: true });

    const header = {
      version: 2,
      width: this.width,
      height: this.height,
      timestamp: Math.floor(this.startedAtMs / 1000),
      title: this.meta.label,
      env: {
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
      },
    };

    const castPath = path.join(this.sessionDir, 'session.cast');
    this.castStream = fs.createWriteStream(castPath, { flags: 'w' });
    this.castStream.write(`${JSON.stringify(header)}\n`);

    const keysPath = path.join(this.sessionDir, 'keys.jsonl');
    this.keysStream = fs.createWriteStream(keysPath, { flags: 'w' });
  }

  elapsedSec() {
    return (Date.now() - this.startedAtMs) / 1000;
  }

  updateSize(cols, rows) {
    this.width = cols;
    this.height = rows;
  }

  recordOutput(data) {
    if (this.closed || !this.castStream || !data) {
      return;
    }

    this.bytesRecorded += Buffer.byteLength(data, 'utf8');
    this.castStream.write(`${JSON.stringify([this.elapsedSec(), 'o', data])}\n`);
  }

  recordInput(data) {
    if (this.closed || !data) {
      return;
    }

    // Keystrokes go to keys.jsonl only. Do not append "i" events to the cast:
    // the SSH server already echoes typed characters in the output stream ("o"),
    // so replaying both would show every character twice (e.g. ssuuddoo).
    if (this.keysStream) {
      this.keysStream.write(`${JSON.stringify({ t: this.elapsedSec(), keys: data })}\n`);
    }
  }

  closeStreams() {
    return new Promise((resolve) => {
      if (!this.castStream && !this.keysStream) {
        resolve();
        return;
      }

      let pending = 0;
      const done = () => {
        pending -= 1;
        if (pending <= 0) {
          resolve();
        }
      };

      if (this.castStream) {
        pending += 1;
        this.castStream.end(done);
        this.castStream = null;
      }

      if (this.keysStream) {
        pending += 1;
        this.keysStream.end(done);
        this.keysStream = null;
      }

      if (pending === 0) {
        resolve();
      }
    });
  }

  async finalize(endReason = 'closed') {
    if (this.closed) {
      return null;
    }

    this.closed = true;
    await this.closeStreams();

    const endedAt = new Date();
    const finalMeta = {
      ...this.meta,
      endedAt: endedAt.toISOString(),
      durationSec: Math.max(0, Math.round((endedAt.getTime() - this.startedAtMs) / 1000)),
      width: this.width,
      height: this.height,
      bytesRecorded: this.bytesRecorded,
      endReason,
      castFile: 'session.cast',
      keysFile: 'keys.jsonl',
    };

    await fsp.writeFile(
      path.join(this.sessionDir, 'meta.json'),
      `${JSON.stringify(finalMeta, null, 2)}\n`,
      'utf8',
    );

    const index = await readIndex(this.baseDir);
    index.sessions = index.sessions.filter((entry) => entry.id !== finalMeta.id);
    index.sessions.push(summarizeSession(finalMeta));
    index.sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    await writeIndex(this.baseDir, index);

    console.info(`[SSH-RECORD] Saved ${finalMeta.id} (${finalMeta.durationSec}s) -> ${finalMeta.relativePath}`);
    return finalMeta;
  }
}

function createRecorder({ enabled, baseDir, meta }) {
  if (!enabled) {
    return null;
  }

  const recorder = new SshSessionRecorder({ baseDir, meta });
  recorder.init();
  return recorder;
}

async function getReport(baseDir, year, month) {
  const index = await readIndex(baseDir);
  const filtered = index.sessions.filter((entry) => {
    if (entry.year !== year) {
      return false;
    }

    if (month && entry.month !== month) {
      return false;
    }

    return true;
  });

  const daysMap = new Map();

  filtered.forEach((session) => {
    if (!daysMap.has(session.day)) {
      daysMap.set(session.day, []);
    }

    daysMap.get(session.day).push(session);
  });

  const days = Array.from(daysMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([day, sessions]) => ({
      day,
      sessions: sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))),
    }));

  return {
    year,
    month: month || null,
    total: filtered.length,
    days,
  };
}

async function findSession(baseDir, sessionId) {
  const index = await readIndex(baseDir);
  const summary = index.sessions.find((entry) => entry.id === sessionId);
  if (!summary) {
    return null;
  }

  const sessionDir = path.join(baseDir, summary.relativePath);
  const metaPath = path.join(sessionDir, 'meta.json');

  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    return { meta, sessionDir, summary };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function readSessionFile(baseDir, sessionId, fileName) {
  const found = await findSession(baseDir, sessionId);
  if (!found) {
    return null;
  }

  const filePath = path.join(found.sessionDir, fileName);
  const raw = await fsp.readFile(filePath, 'utf8');
  return { raw, meta: found.meta };
}

module.exports = {
  INDEX_FILE,
  createRecorder,
  createSessionId,
  getReport,
  findSession,
  readSessionFile,
  summarizeSession,
};
