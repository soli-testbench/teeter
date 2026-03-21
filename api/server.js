const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const DATA_DIR = '/data';
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const MAX_SCORES = 10;
const MAX_BODY = 1024;
const MAX_NAME_LENGTH = 15;
const MAX_SCORE_VALUE = 999999;

// Rate limiting: max POST requests per IP within a sliding window.
// 5 POSTs/min/IP is sufficient for a game leaderboard (one score per
// completed game) and limits abuse surface.
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_POSTS = 5;
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry) {
    entry = [];
    rateLimitMap.set(ip, entry);
  }
  // Remove expired timestamps
  while (entry.length > 0 && entry[0] <= now - RATE_LIMIT_WINDOW_MS) {
    entry.shift();
  }
  if (entry.length >= RATE_LIMIT_MAX_POSTS) {
    return true;
  }
  entry.push(now);
  return false;
}

// Periodically clean up stale rate-limit entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length === 0) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function readScores() {
  try {
    const raw = fs.readFileSync(SCORES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(e => typeof e.name === 'string' && typeof e.score === 'number')
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SCORES);
  } catch {
    return [];
  }
}

function writeScores(scores) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: write to temp file then rename to prevent corruption.
  // Mode 0o600 restricts the file to owner-only read/write.
  const tmpFile = SCORES_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(scores), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, SCORES_FILE);
}

// Serializes write operations so concurrent POSTs cannot lose updates.
// Each call to withWriteLock(fn) waits for the previous write to finish
// before executing fn, ensuring read-modify-write is atomic.
let _writeLock = Promise.resolve();
function withWriteLock(fn) {
  _writeLock = _writeLock.then(fn, () => fn());
  return _writeLock;
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok' });
    return;
  }

  if (url.pathname !== '/api/scores') {
    sendError(res, 404, 'Not found');
    return;
  }

  if (req.method === 'GET') {
    const scores = readScores();
    sendJSON(res, 200, scores);
    return;
  }

  if (req.method === 'POST') {
    // Only trust X-Real-IP when the connection originates from loopback
    // (i.e. from our nginx reverse proxy). The server binds to 127.0.0.1
    // so all legitimate connections are loopback, but this guard defends
    // against misconfiguration where the server is exposed directly.
    const peerIp = req.socket.remoteAddress || '';
    const isLoopback = peerIp === '127.0.0.1' || peerIp === '::1' || peerIp === '::ffff:127.0.0.1';
    const clientIp = (isLoopback && req.headers['x-real-ip']) ? req.headers['x-real-ip'] : peerIp || 'unknown';
    if (isRateLimited(clientIp)) {
      sendError(res, 429, 'Too many requests. Try again later.');
      return;
    }

    let body = '';
    let tooLarge = false;

    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        req.destroy();
      }
    });

    req.on('end', () => {
      if (tooLarge) {
        sendError(res, 413, 'Payload too large');
        return;
      }

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        sendError(res, 400, 'Invalid JSON');
        return;
      }

      // Validate name — reject empty/whitespace-only names
      if (typeof data.name !== 'string') {
        sendError(res, 400, 'Name must be a string');
        return;
      }
      const name = data.name.trim();
      if (!name) {
        sendError(res, 400, 'Name must not be empty');
        return;
      }
      if (name.length > MAX_NAME_LENGTH) {
        sendError(res, 400, 'Name must be at most ' + MAX_NAME_LENGTH + ' characters');
        return;
      }

      // Validate score
      const score = data.score;
      if (typeof score !== 'number' || !Number.isInteger(score) || score <= 0 || score > MAX_SCORE_VALUE) {
        sendError(res, 400, 'Score must be a positive integer (1-' + MAX_SCORE_VALUE + ')');
        return;
      }

      withWriteLock(() => {
        try {
          const scores = readScores();
          scores.push({ name, score });
          scores.sort((a, b) => b.score - a.score);
          const trimmed = scores.slice(0, MAX_SCORES);
          writeScores(trimmed);
          sendJSON(res, 201, trimmed);
        } catch (err) {
          sendError(res, 500, 'Internal server error');
        }
      });
    });

    return;
  }

  sendError(res, 405, 'Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Scores API listening on 127.0.0.1:' + PORT);
});
