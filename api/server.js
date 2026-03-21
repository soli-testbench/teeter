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

// --- Authentication & Threat Model ---
// Auth model: anonymous submissions by design.
//
// The browser game client (js/main.js) submits scores via fetch('/api/scores')
// without credentials. Since the client is public JS, embedding an API key
// would provide no real security (any user can read it from DevTools).
//
// Defense-in-depth layers that protect the leaderboard without auth:
// - Rate limiting (3 POST/min/IP) bounds casual abuse volume.
// - Per-IP cooldown (10s between successful submissions) prevents rapid-fire.
// - Duplicate detection rejects exact name+score replays already on the board.
// - Body-size cap (1024 B) and input validation reject malformed payloads.
// - Server binds to 127.0.0.1 only; nginx proxies external traffic and
//   sets X-Real-IP, so clients cannot spoof their IP directly.
// - CORS headers are not sent, so cross-origin browser requests are blocked.
// - CSP connect-src 'self' prevents scripts on other origins from hitting /api.
// - Score plausibility: positive integers only, capped at MAX_SCORE_VALUE.
//
// SCORE_API_KEY (env var): Optional. When set, POST /api/scores requires a
// matching "X-API-Key" header. This is useful for server-to-server integrations
// or if the operator adds a backend proxy that injects the key. It is NOT
// required for the default browser-based deployment.
const SCORE_API_KEY = process.env.SCORE_API_KEY || '';

if (SCORE_API_KEY) {
  console.log('INFO: SCORE_API_KEY is set — POST /api/scores requires X-API-Key header.');
} else {
  console.log(
    'INFO: SCORE_API_KEY is not set — POST /api/scores accepts anonymous submissions. ' +
    'This is the expected configuration for browser-based deployments. ' +
    'Set SCORE_API_KEY to require X-API-Key header for server-to-server use.'
  );
}

// Deployment model: this server is designed for single-instance deployments
// (one container with a persistent /data volume). The JSON file store is not
// safe for multi-replica use — if horizontal scaling is needed, replace the
// file store with a shared external datastore (e.g. Redis or a database).

// Rate limiting: max POST requests per IP within a sliding window.
// 3 POSTs/min/IP is sufficient for a game leaderboard (one score per
// completed game) and limits abuse surface.
// Note: in-memory state resets on server restart. This is acceptable because
// the bounded restart loop in start.sh (max 5 restarts/60s) limits how
// often the counter resets, and the threat model is casual abuse, not DDoS.
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_POSTS = 3;
const rateLimitMap = new Map();

// Cooldown: minimum interval between successful score submissions per IP.
// Prevents automated rapid-fire submissions even within the rate limit window.
const SCORE_COOLDOWN_MS = 10 * 1000; // 10 seconds
const lastSubmitMap = new Map();

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

// Periodically clean up stale rate-limit and cooldown entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length === 0) rateLimitMap.delete(ip);
  }
  for (const [ip, ts] of lastSubmitMap) {
    if (ts <= now - SCORE_COOLDOWN_MS) lastSubmitMap.delete(ip);
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

  // Deny CORS preflight — no Access-Control-Allow-Origin header is sent,
  // so browsers will block cross-origin requests. This is defense-in-depth
  // alongside nginx proxy and CSP connect-src: 'self'.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

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

    // Enforce API key when configured (defense-in-depth against anonymous abuse)
    if (SCORE_API_KEY && req.headers['x-api-key'] !== SCORE_API_KEY) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }

    // Cooldown: reject if this IP submitted a score too recently
    const lastSubmit = lastSubmitMap.get(clientIp);
    if (lastSubmit && (Date.now() - lastSubmit) < SCORE_COOLDOWN_MS) {
      sendError(res, 429, 'Please wait before submitting another score.');
      return;
    }

    let body = '';
    let tooLarge = false;

    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        // Send 413 immediately and consume remaining data to avoid connection reset.
        // resume() drains any buffered chunks so the client sees a clean HTTP response
        // instead of a TCP RST.
        sendError(res, 413, 'Payload too large');
        req.resume();
      }
    });

    req.on('end', () => {
      if (tooLarge) return;

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

          // Anomaly check: reject exact duplicate name+score from same request
          // (protects against replay-style abuse)
          const isDuplicate = scores.some(e => e.name === name && e.score === score);
          if (isDuplicate) {
            sendError(res, 409, 'Duplicate score entry');
            return;
          }

          scores.push({ name, score });
          scores.sort((a, b) => b.score - a.score);
          const trimmed = scores.slice(0, MAX_SCORES);
          writeScores(trimmed);
          lastSubmitMap.set(clientIp, Date.now());
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
