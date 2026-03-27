const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

const app = express();
app.disable('x-powered-by');
// Trust the first proxy (e.g. Docker/cloud load balancer) so that
// req.protocol and req.ip reflect the real client, not the proxy.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'scores.db');
const MAX_SCORES = 10;

// Retention cap: maximum number of rows kept in the scores table.
// Prevents unbounded storage growth while preserving recent history.
// Configurable via MAX_RETAINED_SCORES env var; defaults to 1000.
const MAX_RETAINED_SCORES = parseInt(process.env.MAX_RETAINED_SCORES, 10) || 1000;

// Score validation constants
const MAX_REASONABLE_SCORE = 10000;
const MAX_NAME_LENGTH = 15;

// Security headers — inline importmap allowed via hash; everything else in external files
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net 'sha256-Cb7VRvgKHYvwTusy6WvuTr1ww8fUTjYTnEACYzG5a/8=' 'wasm-unsafe-eval'; " +
    "style-src 'self'; " +
    "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; " +
    "worker-src 'self' blob:; " +
    "img-src 'self' data: blob:; " +
    "frame-ancestors 'self' http://localhost:3000 https://venice-internal-flax.vercel.app"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Ensure data directory exists
const fs = require('fs');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize SQLite database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC)`);

// Prepared statements
const getTopScores = db.prepare(
  'SELECT name, score FROM scores ORDER BY score DESC LIMIT ?'
);
const getMinTopScore = db.prepare(
  'SELECT MIN(score) as min_score FROM (SELECT score FROM scores ORDER BY score DESC LIMIT ?)'
);
const countScores = db.prepare('SELECT COUNT(*) as count FROM scores');
const insertScore = db.prepare(
  'INSERT INTO scores (name, score) VALUES (?, ?)'
);

// Retention: delete oldest rows beyond the cap, preserving the top MAX_SCORES
// regardless of age plus additional recent history up to MAX_RETAINED_SCORES.
const pruneOldScores = db.prepare(`
  DELETE FROM scores WHERE id NOT IN (
    SELECT id FROM scores ORDER BY score DESC LIMIT ?
  ) AND id NOT IN (
    SELECT id FROM scores ORDER BY created_at DESC LIMIT ?
  )
`);

// Transactional insert with bounded retention
const insertAndRetain = db.transaction((name, score) => {
  insertScore.run(name, score);
  const { count } = countScores.get();
  if (count > MAX_RETAINED_SCORES) {
    // Keep the top MAX_SCORES by score and the newest MAX_RETAINED_SCORES by date
    pruneOldScores.run(MAX_SCORES, MAX_RETAINED_SCORES);
  }
});

// Middleware
app.use(express.json({ limit: '1kb' }));

// Rate limiting for score submissions:
// - Burst limit: 5 requests per minute per IP
// - Daily limit: 100 requests per day per IP
const scoreSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many score submissions. Please try again later.' },
});

const scoreDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Daily submission limit reached. Please try again tomorrow.' },
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Reject cross-origin API requests:
// 1. Explicit CORS policy — never send Access-Control-Allow-Origin, so
//    browsers will block any cross-origin fetch/XHR response.
// 2. Strict Origin check — if an Origin header is present, it must exactly
//    match the expected scheme+host (no substring matching).
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (!origin) {
    // No Origin header means same-origin (non-CORS) request — allow
    return next();
  }
  const expectedOrigin = req.protocol + '://' + req.get('Host');
  if (origin !== expectedOrigin) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }
  next();
});

// API: Get top scores
app.get('/api/scores', (req, res) => {
  try {
    const scores = getTopScores.all(MAX_SCORES);
    res.json({ scores });
  } catch (err) {
    console.error('Error fetching scores:', err);
    res.status(500).json({ error: 'Failed to fetch scores.' });
  }
});

// API: Submit a score
app.post('/api/scores', scoreDailyLimiter, scoreSubmitLimiter, (req, res) => {
  try {
    const { name, score } = req.body;

    // Validate name
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    const sanitizedName = name.trim().slice(0, MAX_NAME_LENGTH);

    // Validate score
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0) {
      return res.status(400).json({ error: 'Score must be a non-negative integer.' });
    }
    if (score > MAX_REASONABLE_SCORE) {
      return res.status(400).json({ error: 'Score exceeds maximum allowed value.' });
    }

    // Check if score qualifies for top 10
    const { count } = countScores.get();
    if (count >= MAX_SCORES) {
      const { min_score } = getMinTopScore.get(MAX_SCORES);
      if (score <= min_score) {
        return res.status(200).json({ 
          qualified: false, 
          message: 'Score did not qualify for the leaderboard.' 
        });
      }
    }

    // Insert score and enforce retention cap
    insertAndRetain(sanitizedName, score);

    const scores = getTopScores.all(MAX_SCORES);
    res.status(201).json({ qualified: true, scores });
  } catch (err) {
    console.error('Error submitting score:', err);
    res.status(500).json({ error: 'Failed to submit score.' });
  }
});

// API: Check if a score qualifies
app.get('/api/scores/qualifies', (req, res) => {
  try {
    const score = parseInt(req.query.score, 10);
    if (isNaN(score) || score < 0) {
      return res.status(400).json({ error: 'Invalid score parameter.' });
    }

    const { count } = countScores.get();
    if (count < MAX_SCORES) {
      return res.json({ qualifies: score > 0 });
    }

    const { min_score } = getMinTopScore.get(MAX_SCORES);
    res.json({ qualifies: score > min_score });
  } catch (err) {
    console.error('Error checking qualification:', err);
    res.status(500).json({ error: 'Failed to check score qualification.' });
  }
});

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Teeter server running on port ${PORT}`);
});
