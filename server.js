const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'scores.db');
const MAX_SCORES = 10;

// Score validation constants
const MAX_REASONABLE_SCORE = 10000;
const MAX_NAME_LENGTH = 15;

// Generate a per-request nonce and attach security headers
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'nonce-" + nonce + "' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; " +
    "worker-src 'self' blob:; " +
    "img-src 'self' data: blob:"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
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

// Note: All historical scores are retained in the database. Only the top
// MAX_SCORES are ever returned by the API. No rows are deleted, so data is
// preserved if requirements expand (e.g. audit, analytics, broader history).

// Middleware
app.use(express.json({ limit: '1kb' }));

// Rate limiting for score submissions (5 per minute per IP)
const scoreSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many score submissions. Please try again later.' },
});

// Serve static files, but skip index.html so it can be served dynamically
// with a per-request CSP nonce injected into the inline script tag.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false
}));

// Reject cross-origin API requests using strict origin equality
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (!origin) {
    // No Origin header means same-origin (non-CORS) request
    return next();
  }
  // Build the expected origin from the Host header
  const proto = req.protocol; // 'http' or 'https'
  const host = req.get('Host');
  const expectedOrigin = proto + '://' + host;
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
app.post('/api/scores', scoreSubmitLimiter, (req, res) => {
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

    // Insert score (all historical scores are retained; only top N are queried)
    insertScore.run(sanitizedName, score);

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

// Serve index.html with CSP nonce injected into the inline script tag
const indexHtmlPath = path.join(__dirname, 'public', 'index.html');
const indexHtmlTemplate = fs.readFileSync(indexHtmlPath, 'utf8');

function serveIndex(req, res) {
  const nonce = res.locals.cspNonce;
  const html = indexHtmlTemplate.replace('<script>', '<script nonce="' + nonce + '">');
  res.type('html').send(html);
}

// Serve index.html at root and as SPA fallback
app.get('/', serveIndex);
app.get('/{*splat}', (req, res, next) => {
  // Only serve index.html for non-file paths (SPA fallback)
  if (req.path.includes('.')) return next();
  serveIndex(req, res);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Teeter server running on port ${PORT}`);
});
