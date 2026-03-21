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

// Rate limiting: max POST requests per IP within a sliding window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_POSTS = 5; // 5 POSTs per minute per IP
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
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores), 'utf8');
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
    // Trust X-Real-IP set by our nginx reverse proxy to avoid
    // rate-limiting all clients as a single shared proxy address
    const clientIp = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
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

      const scores = readScores();
      scores.push({ name, score });
      scores.sort((a, b) => b.score - a.score);
      const trimmed = scores.slice(0, MAX_SCORES);
      writeScores(trimmed);
      sendJSON(res, 201, trimmed);
    });

    return;
  }

  sendError(res, 405, 'Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Scores API listening on 127.0.0.1:' + PORT);
});
