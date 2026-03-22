const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3001;
const DATA_DIR = '/data';
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const MAX_SCORES = 10;
const MAX_BODY = 1024;
const MAX_NAME_LENGTH = 15;
const MAX_SCORE_VALUE = 999999;

// --- Authentication & Threat Model ---
// Auth model: server-issued challenge tokens for write integrity.
//
// The browser game client requests a one-time challenge token from
// GET /api/challenge before submitting a score. POST /api/scores requires
// a valid, unexpired token — this prevents automated replay attacks and
// ensures each submission was preceded by a server interaction.
//
// Threat model & abuse limits for anonymous scoreboard submissions:
//   Asset: shared game leaderboard (top 10 scores). Low-value target —
//     worst-case abuse is fake scores, not data loss or privilege escalation.
//   Threat actors: casual cheaters submitting fake scores from a browser.
//     Sophisticated attackers (curl/scripts) are bounded by rate limits.
//   Accepted risk: a determined attacker with multiple IPs could insert
//     fake scores. This is acceptable for a casual game leaderboard.
//     If stronger guarantees are needed, set SCORE_API_KEY and gate
//     submissions through a backend proxy with user authentication.
//
// Defense-in-depth layers:
// - Challenge tokens: one-time-use, IP-bound, expire after 5 minutes.
//   Max 5 pending tokens per IP to prevent memory exhaustion.
// - Rate limiting (3 POST/min/IP) bounds abuse volume to ~180 submissions/hour.
// - Per-IP cooldown (10s between successful submissions) prevents rapid-fire.
// - Duplicate detection rejects exact name+score replays already on the board.
// - Body-size cap (1024 B) and input validation reject malformed payloads.
// - Server binds to 127.0.0.1 only; nginx proxies external traffic and
//   sets X-Real-IP, so clients cannot spoof their IP directly.
// - No Access-Control-Allow-Origin header is sent; Vary: Origin signals
//   intent. Cross-origin browser requests are blocked by CORS policy.
// - CSP connect-src 'self' prevents scripts on other origins from hitting /api.
// - Score plausibility: positive integers only, capped at MAX_SCORE_VALUE.
//
// SCORE_API_KEY (env var): Optional, for server-to-server integrations only.
// When set, POST /api/scores additionally requires a matching "X-API-Key"
// header. This mode is NOT intended for direct browser use — the browser
// client cannot securely hold an API key.
//   - Set SCORE_API_KEY via environment variable (docker -e or compose env).
//   - Route browser submissions through a backend proxy that authenticates
//     users and injects the key into forwarded requests.
//   - For server-to-server integrations, pass the key directly in X-API-Key.
// Default auth mode (Docker image ships with ALLOW_ANONYMOUS_SCORES=true):
//   The image enables the shared global leaderboard out of the box — this is
//   the primary use case (casual browser game with no user accounts).
//   Defense-in-depth layers (challenge tokens, rate limiting, cooldown)
//   activate automatically.
//   To require API-key auth instead, set SCORE_API_KEY and optionally
//   set ALLOW_ANONYMOUS_SCORES=false.
//
// ALLOW_ANONYMOUS_SCORES (env var): Controls anonymous score submissions in
// production without SCORE_API_KEY. The Docker image defaults to "true"
// so the shared global leaderboard works out of the box.
// Set to "false" and provide SCORE_API_KEY for authenticated-only mode.
// When enabled, defense-in-depth layers (challenge tokens, rate limiting,
// cooldown, CORS denial) provide abuse resistance appropriate for a casual
// game leaderboard.
//
// --- Operational monitoring thresholds ---
// Monitor these indicators to detect abuse or misconfiguration:
//   - Rate-limit 429 responses > 50/min → possible automated abuse
//   - Challenge 429 responses (farming) → bot probing for tokens
//   - 413 responses > 10/min → payload-stuffing attack
//   - scores.json file size growing beyond ~10KB → leak in MAX_SCORES enforcement
//   - Server restart count (logged by start.sh) > 3/hour → crash loop
// Use container log aggregation (stdout/stderr) for alerting. The server
// logs rate-limit events and challenge rejections to stderr.
//
// --- Security acceptance: anonymous write endpoint ---
// POST /api/scores is intentionally anonymous by default to support
// browser-based gameplay without user accounts. Mitigations in place:
//   1. Challenge tokens (one-time, IP-bound, 5-min TTL, max 5 pending/IP)
//   2. Rate limiting (3 POST/min/IP)
//   3. Per-IP cooldown (10s between successful submissions)
//   4. Duplicate detection (exact name+score replay rejected)
//   5. Input validation (name length, score range, body size cap)
//   6. CORS denial (no Access-Control-Allow-Origin header)
//   7. CSP connect-src: 'self' (blocks cross-origin script access)
//   8. Server binds 127.0.0.1 only (nginx proxy required)
// In production with ALLOW_ANONYMOUS_SCORES=false, SCORE_API_KEY is required.
const SCORE_API_KEY = process.env.SCORE_API_KEY || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOW_ANONYMOUS_SCORES = process.env.ALLOW_ANONYMOUS_SCORES === 'true';

// Production enforcement: reject startup if SCORE_API_KEY is not set and
// ALLOW_ANONYMOUS_SCORES is not explicitly enabled. This prevents accidental
// deployment of an unauthenticated write endpoint in production.
if (NODE_ENV === 'production' && !SCORE_API_KEY && !ALLOW_ANONYMOUS_SCORES) {
  console.error(
    'FATAL: NODE_ENV=production but SCORE_API_KEY is not set. ' +
    'Refusing to start with an unauthenticated write endpoint in production. ' +
    'Fix: set SCORE_API_KEY via environment variable, or explicitly opt in to ' +
    'anonymous submissions with ALLOW_ANONYMOUS_SCORES=true.'
  );
  process.exit(1);
}

if (NODE_ENV === 'production' && !SCORE_API_KEY && ALLOW_ANONYMOUS_SCORES) {
  console.warn(
    'WARNING: NODE_ENV=production with ALLOW_ANONYMOUS_SCORES=true (explicit opt-in). ' +
    'Score submissions accepted without API-key authentication. ' +
    'Abuse resistance: challenge tokens (one-time, IP-bound, 5-min TTL), ' +
    'rate limiting (3/min/IP), cooldown (10s/IP), duplicate detection. ' +
    'Accepted risk: determined attacker with multiple IPs could insert fake scores. ' +
    'For stronger guarantees, set SCORE_API_KEY and use a backend proxy.'
  );
}

if (SCORE_API_KEY) {
  console.log('INFO: SCORE_API_KEY is set — POST /api/scores requires X-API-Key header.');
} else if (NODE_ENV !== 'production') {
  console.log(
    'INFO: SCORE_API_KEY is not set — POST /api/scores accepts anonymous submissions. ' +
    'This is the expected configuration for local/demo browser-based deployments.'
  );
}

// Deployment model: this server is designed for single-instance deployments
// (one container with a persistent /data volume). The JSON file store is not
// safe for multi-replica use — if horizontal scaling is needed, replace the
// file store with a shared external datastore (e.g. Redis or a database).

// Rate limiting: max POST requests per IP within a sliding window.
// 3 POSTs/min/IP is sufficient for a game leaderboard (one score per
// completed game) and limits abuse surface. Combined with the 10s per-IP
// cooldown and one-time challenge tokens, effective throughput is bounded
// to ~6 scores/min/IP at most, which is adequate for the expected
// single-instance casual game deployment.
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

// --- Challenge Token System ---
// One-time-use tokens issued by GET /api/challenge, required for POST /api/scores.
// Tokens are bound to the requesting IP and expire after CHALLENGE_TTL_MS.
// This prevents automated score submission without first interacting with the server.
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const challengeMap = new Map(); // token -> { ip, expires }
const MAX_CHALLENGES_PER_IP = 5;

function issueChallenge(ip) {
  // Enforce per-IP limit to prevent memory exhaustion from challenge farming
  let count = 0;
  for (const entry of challengeMap.values()) {
    if (entry.ip === ip) count++;
  }
  if (count >= MAX_CHALLENGES_PER_IP) {
    return null;
  }
  const token = crypto.randomBytes(24).toString('hex');
  challengeMap.set(token, { ip, expires: Date.now() + CHALLENGE_TTL_MS });
  return token;
}

function consumeChallenge(token, ip) {
  const entry = challengeMap.get(token);
  if (!entry) return false;
  challengeMap.delete(token); // one-time use
  if (entry.ip !== ip) return false;
  if (Date.now() > entry.expires) return false;
  return true;
}

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

// Periodically clean up stale rate-limit, cooldown, and challenge entries
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
  for (const [token, entry] of challengeMap) {
    if (now > entry.expires) challengeMap.delete(token);
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

// CORS denial headers: explicitly block cross-origin requests as defense-in-depth.
// Browsers already block cross-origin fetch when no Access-Control-Allow-Origin is
// present, but sending a restrictive Vary header and omitting ACAO makes the intent
// explicit. This supplements nginx CSP connect-src: 'self'.
const COMMON_HEADERS = {
  'Vary': 'Origin',
};

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...COMMON_HEADERS,
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
    res.writeHead(204, COMMON_HEADERS);
    res.end();
    return;
  }

  if (url.pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok' });
    return;
  }

  // Issue a one-time challenge token for score submission.
  // The client must GET /api/challenge first, then include the token in POST /api/scores.
  if (url.pathname === '/api/challenge' && req.method === 'GET') {
    const peerIp = req.socket.remoteAddress || '';
    const isLoopback = peerIp === '127.0.0.1' || peerIp === '::1' || peerIp === '::ffff:127.0.0.1';
    const clientIp = (isLoopback && req.headers['x-real-ip']) ? req.headers['x-real-ip'] : peerIp || 'unknown';
    const token = issueChallenge(clientIp);
    if (!token) {
      console.error(`MONITOR: 429 challenge-farming ip=${clientIp}`);
      sendError(res, 429, 'Too many pending challenges');
      return;
    }
    sendJSON(res, 200, { token });
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
      console.error(`MONITOR: 429 rate-limited ip=${clientIp}`);
      sendError(res, 429, 'Too many requests. Try again later.');
      return;
    }

    // Enforce API key when configured (defense-in-depth against anonymous abuse).
    // Uses crypto.timingSafeEqual to prevent timing side-channel leaks.
    if (SCORE_API_KEY) {
      const provided = req.headers['x-api-key'] || '';
      const expected = SCORE_API_KEY;
      const providedBuf = Buffer.from(provided);
      const expectedBuf = Buffer.from(expected);
      if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
        console.error(`MONITOR: 401 invalid-api-key ip=${clientIp}`);
        sendError(res, 401, 'Invalid or missing API key');
        return;
      }
    }

    // Validate challenge token (required for write integrity)
    const challengeToken = req.headers['x-challenge-token'] || '';
    if (!challengeToken || !consumeChallenge(challengeToken, clientIp)) {
      console.error(`MONITOR: 403 invalid-challenge ip=${clientIp}`);
      sendError(res, 403, 'Missing or invalid challenge token. GET /api/challenge first.');
      return;
    }

    // Cooldown: reject if this IP submitted a score too recently
    const lastSubmit = lastSubmitMap.get(clientIp);
    if (lastSubmit && (Date.now() - lastSubmit) < SCORE_COOLDOWN_MS) {
      console.error(`MONITOR: 429 cooldown ip=${clientIp}`);
      sendError(res, 429, 'Please wait before submitting another score.');
      return;
    }

    let body = '';
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return; // Already responded 413 — ignore further chunks
      body += chunk;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        // Send 413 exactly once and consume remaining data to avoid connection reset.
        // resume() drains any buffered chunks so the client sees a clean HTTP response
        // instead of a TCP RST.
        console.error(`MONITOR: 413 payload-too-large ip=${clientIp}`);
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

      // Validate name — reject empty/whitespace-only names and control characters
      if (typeof data.name !== 'string') {
        sendError(res, 400, 'Name must be a string');
        return;
      }
      // Strip control characters (U+0000-001F, U+007F, U+0080-009F) before trimming
      // to prevent invisible/unprintable characters in leaderboard names
      const name = data.name.replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '').trim();
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
