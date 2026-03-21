/**
 * Integration tests for /api/scores endpoint.
 * Uses only Node.js built-in modules — no external dependencies.
 *
 * Spawns the server on a temp data dir, runs assertions, then tears down.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os');

const PORT = 3099; // Use a non-standard port for testing
let serverProcess;
let tmpDir;
let passed = 0;
let failed = 0;

// Obtain a challenge token from the server (required for POST /api/scores)
function getChallenge(port) {
  port = port || PORT;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/challenge', method: 'GET' }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          resolve(json.token);
        } catch {
          reject(new Error('Failed to parse challenge token'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function request(method, body, extraHeaders) {
  return new Promise(async (resolve, reject) => {
    try {
      const options = {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/scores',
        method,
        headers: { ...(extraHeaders || {}) },
      };
      // For POST requests, automatically obtain a challenge token
      if (method === 'POST' && !options.headers['X-Challenge-Token']) {
        const token = await getChallenge();
        options.headers['X-Challenge-Token'] = token;
      }
      if (body !== undefined) {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = http.request(options, (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let json;
          try { json = JSON.parse(chunks); } catch { json = chunks; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// POST without automatically obtaining a challenge token (for testing token enforcement)
function requestNoChallenge(method, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/scores',
      method,
      headers: { ...(extraHeaders || {}) },
    };
    if (body !== undefined) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(chunks); } catch { json = chunks; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function requestRaw(method, path_) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: path_, method }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(chunks); } catch { json = chunks; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function waitForServer(retries = 20, delay = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      await request('GET');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Server did not start');
}

function waitForPort(port, retries, delay) {
  retries = retries || 20;
  delay = delay || 200;
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < retries; i++) {
      try {
        await new Promise((res, rej) => {
          const req = http.request({ hostname: '127.0.0.1', port, path: '/api/health', method: 'GET' }, (r) => {
            r.on('data', () => {});
            r.on('end', () => res());
          });
          req.on('error', rej);
          req.end();
        });
        return resolve();
      } catch {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    reject(new Error('Server on port ' + port + ' did not start'));
  });
}

// Helper: POST to a specific port with challenge token
function postWithChallenge(port, body, extraHeaders) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getChallenge(port);
      const data = JSON.stringify(body);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Challenge-Token': token,
        ...(extraHeaders || {}),
      };
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/scores', method: 'POST', headers,
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => {
          let json;
          try { json = JSON.parse(chunks); } catch { json = chunks; }
          resolve({ status: r.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function run() {
  // Create temp data directory
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-test-'));

  // Patch the server to use our port and temp dir by writing a wrapper
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const patched = serverSrc
    .replace(/const PORT = \d+;/, `const PORT = ${PORT};`)
    .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${tmpDir.replace(/\\/g, '/')}';`)
    .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
    .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;')
    .replace(/const MAX_CHALLENGES_PER_IP = \d+;/, 'const MAX_CHALLENGES_PER_IP = 100;');
  const patchedPath = path.join(tmpDir, 'server.patched.js');
  fs.writeFileSync(patchedPath, patched);

  // Spawn server
  serverProcess = spawn(process.execPath, [patchedPath], { stdio: 'pipe' });
  serverProcess.stderr.on('data', () => {});
  serverProcess.stdout.on('data', () => {});

  await waitForServer();

  console.log('Running /api/scores tests...\n');

  // --- GET tests ---
  await test('GET /api/scores returns empty array initially', async () => {
    const res = await request('GET');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, []);
  });

  await test('GET /unknown returns 404', async () => {
    const res = await requestRaw('GET', '/unknown');
    assert.strictEqual(res.status, 404);
  });

  // --- Challenge token tests ---
  await test('GET /api/challenge returns a token', async () => {
    const token = await getChallenge();
    assert.ok(typeof token === 'string', 'Token should be a string');
    assert.ok(token.length > 0, 'Token should not be empty');
  });

  await test('POST without challenge token returns 403', async () => {
    const res = await requestNoChallenge('POST', { name: 'NoToken', score: 10 });
    assert.strictEqual(res.status, 403, 'Expected 403 without challenge token');
    assert.ok(res.body.error.includes('challenge'), 'Expected challenge error message');
  });

  await test('POST with invalid challenge token returns 403', async () => {
    const res = await requestNoChallenge('POST', { name: 'BadToken', score: 10 }, { 'X-Challenge-Token': 'invalid-token-value' });
    assert.strictEqual(res.status, 403, 'Expected 403 with invalid token');
  });

  await test('Challenge token cannot be reused (one-time-use)', async () => {
    const token = await getChallenge();
    // First use — should succeed
    const first = await requestNoChallenge('POST', { name: 'Reuse1', score: 10 }, { 'X-Challenge-Token': token });
    assert.strictEqual(first.status, 201, 'First use should succeed');
    // Second use of same token — should be rejected
    const second = await requestNoChallenge('POST', { name: 'Reuse2', score: 20 }, { 'X-Challenge-Token': token });
    assert.strictEqual(second.status, 403, 'Reused token should be rejected');
  });

  // --- POST validation tests ---
  await test('POST with invalid JSON returns 400', async () => {
    const res = await request('POST', 'not json');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Invalid JSON'));
  });

  await test('POST with missing name returns 400', async () => {
    const res = await request('POST', { score: 10 });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Name must be a string'));
  });

  await test('POST with non-integer score returns 400', async () => {
    const res = await request('POST', { name: 'Test', score: 1.5 });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('positive integer'));
  });

  await test('POST with zero score returns 400', async () => {
    const res = await request('POST', { name: 'Test', score: 0 });
    assert.strictEqual(res.status, 400);
  });

  await test('POST with negative score returns 400', async () => {
    const res = await request('POST', { name: 'Test', score: -5 });
    assert.strictEqual(res.status, 400);
  });

  await test('POST with score exceeding max returns 400', async () => {
    const res = await request('POST', { name: 'Test', score: 1000000 });
    assert.strictEqual(res.status, 400);
  });

  await test('POST with string score returns 400', async () => {
    const res = await request('POST', { name: 'Test', score: 'abc' });
    assert.strictEqual(res.status, 400);
  });

  // --- POST success tests ---
  await test('POST with valid data returns 201 and score list', async () => {
    // Reset scores to ensure clean state
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), '[]', 'utf8');
    const res = await request('POST', { name: 'Alice', score: 100 });
    assert.strictEqual(res.status, 201);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].name, 'Alice');
    assert.strictEqual(res.body[0].score, 100);
  });

  await test('POST with empty name returns 400', async () => {
    const res = await request('POST', { name: '  ', score: 50 });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('empty'));
  });

  await test('POST with name exceeding max length returns 400', async () => {
    const res = await request('POST', { name: 'A'.repeat(30), score: 75 });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('at most'));
  });

  await test('Scores are sorted descending', async () => {
    const res = await request('GET');
    assert.strictEqual(res.status, 200);
    for (let i = 1; i < res.body.length; i++) {
      assert.ok(res.body[i - 1].score >= res.body[i].score);
    }
  });

  await test('Scores file is persisted to disk', async () => {
    const raw = fs.readFileSync(path.join(tmpDir, 'scores.json'), 'utf8');
    const scores = JSON.parse(raw);
    assert.ok(Array.isArray(scores));
    assert.ok(scores.length > 0);
  });

  await test('Top 10 limit is enforced', async () => {
    // Add enough scores to exceed MAX_SCORES (10)
    for (let i = 0; i < 12; i++) {
      await request('POST', { name: `Player${i}`, score: i + 1 });
    }
    const res = await request('GET');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.length <= 10);
  });

  // --- Method not allowed ---
  await test('PUT returns 405', async () => {
    const res = await requestRaw('PUT', '/api/scores');
    assert.strictEqual(res.status, 405);
  });

  await test('DELETE returns 405', async () => {
    const res = await requestRaw('DELETE', '/api/scores');
    assert.strictEqual(res.status, 405);
  });

  // --- Oversized POST body ---
  await test('POST with oversized body returns 413 (no connection reset)', async () => {
    const token = await getChallenge();
    const bigBody = JSON.stringify({ name: 'X', score: 1, padding: 'A'.repeat(2048) });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: PORT, path: '/api/scores', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bigBody),
          'X-Challenge-Token': token,
        },
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => {
          let json;
          try { json = JSON.parse(chunks); } catch { json = chunks; }
          resolve({ status: r.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.write(bigBody);
      req.end();
    });
    assert.strictEqual(res.status, 413, 'Expected 413 Payload Too Large');
    assert.ok(res.body.error.includes('too large'), 'Expected error message about payload size');
  });

  // --- Fallback behavior: corrupted file ---
  await test('GET returns empty array when scores file is corrupted', async () => {
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), 'NOT JSON', 'utf8');
    const res = await request('GET');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, []);
  });

  await test('POST recovers from corrupted scores file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), 'NOT JSON', 'utf8');
    const res = await request('POST', { name: 'Recovery', score: 42 });
    assert.strictEqual(res.status, 201);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].name, 'Recovery');
  });

  // --- Rate limiting ---
  // The main server has a high rate limit (100) for functional tests.
  // Spawn a second server with a low limit (3) to verify rate limiting works.
  await test('Rate limiting kicks in after exceeding threshold', async () => {
    const rlPort = PORT + 1;
    const rlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-rl-'));
    const rlPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${rlPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${rlDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 3;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
    const rlPath = path.join(rlDir, 'server.rl.js');
    fs.writeFileSync(rlPath, rlPatched);
    const rlProc = spawn(process.execPath, [rlPath], { stdio: 'pipe' });
    rlProc.stderr.on('data', () => {});
    rlProc.stdout.on('data', () => {});

    await waitForPort(rlPort);

    let rateLimited = false;
    for (let i = 0; i < 6; i++) {
      const res = await postWithChallenge(rlPort, { name: `Flood${i}`, score: i + 1 });
      if (res.status === 429) {
        rateLimited = true;
        break;
      }
    }

    rlProc.kill('SIGTERM');
    try { fs.rmSync(rlDir, { recursive: true }); } catch {}
    assert.ok(rateLimited, 'Expected rate limiting (429) but it never triggered');
  });

  // --- API key authentication ---
  // Spawn a server with SCORE_API_KEY set to verify auth enforcement.
  await test('POST without API key returns 401 when SCORE_API_KEY is set', async () => {
    const akPort = PORT + 2;
    const akDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-ak-'));
    const akPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${akPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${akDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
    const akPath = path.join(akDir, 'server.ak.js');
    fs.writeFileSync(akPath, akPatched);
    const akProc = spawn(process.execPath, [akPath], {
      stdio: 'pipe',
      env: { ...process.env, SCORE_API_KEY: 'test-secret-key' },
    });
    akProc.stderr.on('data', () => {});
    akProc.stdout.on('data', () => {});

    await waitForPort(akPort);

    // POST without API key — should be rejected (401 before challenge check)
    const noKeyRes = await postWithChallenge(akPort, { name: 'NoKey', score: 10 });
    assert.strictEqual(noKeyRes.status, 401, 'Expected 401 without API key');

    // POST with wrong API key — should be rejected
    const wrongKeyRes = await postWithChallenge(akPort, { name: 'WrongKey', score: 10 }, { 'X-API-Key': 'wrong-key' });
    assert.strictEqual(wrongKeyRes.status, 401, 'Expected 401 with wrong API key');

    // POST with correct API key — should succeed
    const goodKeyRes = await postWithChallenge(akPort, { name: 'GoodKey', score: 10 }, { 'X-API-Key': 'test-secret-key' });
    assert.strictEqual(goodKeyRes.status, 201, 'Expected 201 with correct API key');

    akProc.kill('SIGTERM');
    try { fs.rmSync(akDir, { recursive: true }); } catch {}
  });

  // --- Production mode guardrails ---
  await test('Server exits in production without SCORE_API_KEY (secure-by-default)', async () => {
    const prodPort = PORT + 3;
    const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-prod-'));
    const prodPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${prodPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${prodDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
    const prodPath = path.join(prodDir, 'server.prod.js');
    fs.writeFileSync(prodPath, prodPatched);

    const prodEnv = { ...process.env };
    delete prodEnv.SCORE_API_KEY;
    delete prodEnv.ALLOW_ANONYMOUS_SCORES;
    prodEnv.NODE_ENV = 'production';
    const prodProc = spawn(process.execPath, [prodPath], {
      stdio: 'pipe',
      env: prodEnv,
    });

    let stderrOutput = '';
    prodProc.stderr.on('data', (d) => { stderrOutput += d.toString(); });
    prodProc.stdout.on('data', () => {});

    // Server should exit with non-zero code (refuses to start without API key)
    const exitCode = await new Promise((resolve) => {
      prodProc.on('exit', (code) => resolve(code));
    });
    assert.strictEqual(exitCode, 1, 'Expected exit code 1 when production lacks SCORE_API_KEY');
    assert.ok(stderrOutput.includes('FATAL'), 'Expected FATAL error message');
    assert.ok(stderrOutput.includes('SCORE_API_KEY'), 'Expected message mentioning SCORE_API_KEY');

    try { fs.rmSync(prodDir, { recursive: true }); } catch {}
  });

  await test('Server starts in production with ALLOW_ANONYMOUS_SCORES=true override', async () => {
    const prodPort = PORT + 3;
    const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-prod-anon-'));
    const prodPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${prodPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${prodDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
    const prodPath = path.join(prodDir, 'server.prod-anon.js');
    fs.writeFileSync(prodPath, prodPatched);

    const prodEnv = { ...process.env };
    delete prodEnv.SCORE_API_KEY;
    prodEnv.NODE_ENV = 'production';
    prodEnv.ALLOW_ANONYMOUS_SCORES = 'true';
    const prodProc = spawn(process.execPath, [prodPath], {
      stdio: 'pipe',
      env: prodEnv,
    });

    let stderrOutput = '';
    prodProc.stderr.on('data', (d) => { stderrOutput += d.toString(); });
    prodProc.stdout.on('data', () => {});

    // Server should start with explicit anonymous override
    await waitForPort(prodPort);
    assert.ok(stderrOutput.includes('ALLOW_ANONYMOUS_SCORES'), 'Expected warning mentioning ALLOW_ANONYMOUS_SCORES');

    // Verify it accepts anonymous submissions
    const postRes = await postWithChallenge(prodPort, { name: 'ProdAnon', score: 77 });
    assert.strictEqual(postRes.status, 201, 'Expected 201 for anonymous POST with ALLOW_ANONYMOUS_SCORES=true');

    prodProc.kill('SIGTERM');
    try { fs.rmSync(prodDir, { recursive: true }); } catch {}
  });

  await test('Server starts in production with SCORE_API_KEY set', async () => {
    const prodPort = PORT + 3;
    const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-prod2-'));
    const prodPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${prodPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${prodDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
    const prodPath = path.join(prodDir, 'server.prod2.js');
    fs.writeFileSync(prodPath, prodPatched);

    const prodProc = spawn(process.execPath, [prodPath], {
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'production', SCORE_API_KEY: 'prod-test-key' },
    });
    prodProc.stderr.on('data', () => {});
    prodProc.stdout.on('data', () => {});

    await waitForPort(prodPort);

    // POST with correct key should succeed
    const postRes = await postWithChallenge(prodPort, { name: 'ProdUser', score: 55 }, { 'X-API-Key': 'prod-test-key' });
    assert.strictEqual(postRes.status, 201, 'Expected 201 for POST in production with API key');
    assert.ok(Array.isArray(postRes.body), 'Expected array response');
    assert.strictEqual(postRes.body[0].name, 'ProdUser');

    // POST without key should be rejected
    const noKeyRes = await postWithChallenge(prodPort, { name: 'NoKey', score: 10 });
    assert.strictEqual(noKeyRes.status, 401, 'Expected 401 without API key in production');

    prodProc.kill('SIGTERM');
    try { fs.rmSync(prodDir, { recursive: true }); } catch {}
  });

  // --- Duplicate detection ---
  await test('POST with duplicate name+score returns 409', async () => {
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), JSON.stringify([{ name: 'DupTest', score: 42 }]), 'utf8');
    const res = await request('POST', { name: 'DupTest', score: 42 });
    assert.strictEqual(res.status, 409, 'Expected 409 for duplicate name+score');
    assert.ok(res.body.error.includes('Duplicate'), 'Expected duplicate error message');
  });

  await test('POST with same name but different score is allowed', async () => {
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), JSON.stringify([{ name: 'DupTest', score: 42 }]), 'utf8');
    const res = await request('POST', { name: 'DupTest', score: 43 });
    assert.strictEqual(res.status, 201, 'Expected 201 for different score');
  });

  // --- Cooldown enforcement ---
  await test('Cooldown rejects rapid successive submissions', async () => {
    const cdPort = PORT + 4;
    const cdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-cd-'));
    const cdPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${cdPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${cdDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 60000;');
    const cdPath = path.join(cdDir, 'server.cd.js');
    fs.writeFileSync(cdPath, cdPatched);
    const cdProc = spawn(process.execPath, [cdPath], { stdio: 'pipe' });
    cdProc.stderr.on('data', () => {});
    cdProc.stdout.on('data', () => {});

    await waitForPort(cdPort);

    // First POST — should succeed
    const first = await postWithChallenge(cdPort, { name: 'CD1', score: 10 });
    assert.strictEqual(first.status, 201, 'First POST should succeed');

    // Second POST — should be rejected by cooldown
    const second = await postWithChallenge(cdPort, { name: 'CD2', score: 20 });
    assert.strictEqual(second.status, 429, 'Second POST should be rejected by cooldown');

    cdProc.kill('SIGTERM');
    try { fs.rmSync(cdDir, { recursive: true }); } catch {}
  });

  // --- Concurrent write integrity test ---
  await test('Concurrent POSTs do not lose updates', async () => {
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), '[]', 'utf8');

    const count = 10;
    const promises = [];
    for (let i = 0; i < count; i++) {
      promises.push(request('POST', { name: `Conc${i}`, score: (i + 1) * 10 }));
    }
    const results = await Promise.all(promises);

    for (const r of results) {
      assert.strictEqual(r.status, 201, 'Expected 201 for concurrent POST');
    }

    const final = await request('GET');
    assert.strictEqual(final.status, 200);
    assert.strictEqual(final.body.length, count,
      `Expected ${count} scores but got ${final.body.length} — concurrent writes lost updates`);
    const names = new Set(final.body.map(e => e.name));
    for (let i = 0; i < count; i++) {
      assert.ok(names.has(`Conc${i}`), `Missing concurrent entry Conc${i}`);
    }
  });

  // --- Crash recovery: scores persist across server restarts ---
  await test('Scores survive server crash and restart (simulated recovery)', async () => {
    const knownScores = [{ name: 'Persist', score: 999 }];
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), JSON.stringify(knownScores), 'utf8');

    serverProcess.kill('SIGKILL');
    await new Promise((r) => serverProcess.on('exit', r));

    serverProcess = spawn(process.execPath, [patchedPath], { stdio: 'pipe' });
    serverProcess.stderr.on('data', () => {});
    serverProcess.stdout.on('data', () => {});
    await waitForServer();

    const res = await request('GET');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.length >= 1, 'Expected at least one score after restart');
    assert.strictEqual(res.body[0].name, 'Persist');
    assert.strictEqual(res.body[0].score, 999);

    const post = await request('POST', { name: 'AfterCrash', score: 500 });
    assert.strictEqual(post.status, 201, 'Expected 201 for POST after crash recovery');
  });

  // --- Abuse-focused tests ---

  await test('Replay: reusing a spent challenge token is rejected', async () => {
    const token = await getChallenge();
    // Use the token once
    const first = await requestNoChallenge('POST', { name: 'Replay1', score: 77 }, { 'X-Challenge-Token': token });
    assert.strictEqual(first.status, 201, 'First use of token should succeed');
    // Replay with exact same request
    const replay = await requestNoChallenge('POST', { name: 'Replay1', score: 77 }, { 'X-Challenge-Token': token });
    assert.strictEqual(replay.status, 403, 'Replayed token should return 403');
  });

  await test('Spam: rapid challenge farming is bounded', async () => {
    // Obtain many challenges rapidly — server should cap per-IP
    const spamPort = PORT + 5;
    const spamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-spam-'));
    const spamPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${spamPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${spamDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;')
      .replace(/const MAX_CHALLENGES_PER_IP = \d+;/, 'const MAX_CHALLENGES_PER_IP = 3;');
    const spamPath = path.join(spamDir, 'server.spam.js');
    fs.writeFileSync(spamPath, spamPatched);
    const spamProc = spawn(process.execPath, [spamPath], { stdio: 'pipe' });
    spamProc.stderr.on('data', () => {});
    spamProc.stdout.on('data', () => {});

    await waitForPort(spamPort);

    let rejected = false;
    for (let i = 0; i < 6; i++) {
      const res = await new Promise((resolve, rej) => {
        const req = http.request({ hostname: '127.0.0.1', port: spamPort, path: '/api/challenge', method: 'GET' }, (r) => {
          let chunks = '';
          r.on('data', (c) => (chunks += c));
          r.on('end', () => resolve({ status: r.statusCode }));
        });
        req.on('error', rej);
        req.end();
      });
      if (res.status === 429) {
        rejected = true;
        break;
      }
    }

    spamProc.kill('SIGTERM');
    try { fs.rmSync(spamDir, { recursive: true }); } catch {}
    assert.ok(rejected, 'Expected 429 when farming too many challenge tokens');
  });

  await test('Health endpoint is accessible', async () => {
    const res = await requestRaw('GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  // --- Challenge rejection integrity tests ---
  // Verify that when the challenge endpoint returns non-OK (e.g. 429),
  // no score is written to the datastore — prevents integrity regressions
  // where the client might bypass server controls on challenge rejection.
  await test('Score is not persisted when challenge endpoint rejects (429)', async () => {
    const intPort = PORT + 6;
    const intDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-int-'));
    // Low challenge limit to trigger 429 quickly
    const intPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${intPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${intDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;')
      .replace(/const MAX_CHALLENGES_PER_IP = \d+;/, 'const MAX_CHALLENGES_PER_IP = 1;');
    const intPath = path.join(intDir, 'server.int.js');
    fs.writeFileSync(intPath, intPatched);
    const intProc = spawn(process.execPath, [intPath], { stdio: 'pipe' });
    intProc.stderr.on('data', () => {});
    intProc.stdout.on('data', () => {});

    await waitForPort(intPort);

    // Record initial scores
    const before = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: intPort, path: '/api/scores', method: 'GET' }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => resolve(JSON.parse(chunks)));
      });
      req.on('error', reject);
      req.end();
    });

    // Request one challenge (uses the only slot)
    await getChallenge(intPort);

    // Second challenge request should get 429
    const challengeRes = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: intPort, path: '/api/challenge', method: 'GET' }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(challengeRes.status, 429, 'Expected 429 on exhausted challenge slots');

    // Verify scores unchanged — no score should have been added
    const after = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: intPort, path: '/api/scores', method: 'GET' }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => resolve(JSON.parse(chunks)));
      });
      req.on('error', reject);
      req.end();
    });
    assert.deepStrictEqual(after, before, 'Scores should not change when challenge is rejected');

    intProc.kill('SIGTERM');
    try { fs.rmSync(intDir, { recursive: true }); } catch {}
  });

  // --- Anonymous deployment path (NODE_ENV=development, no SCORE_API_KEY) ---
  // Verifies the shared leaderboard works when operators use development mode.
  // Docker default is NODE_ENV=production (secure-by-default); operators set
  // NODE_ENV=development for local/demo play with anonymous submissions.
  await test('Anonymous mode: score submission succeeds with NODE_ENV=development, no API key', async () => {
    const defPort = PORT + 7;
    const defDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-default-'));
    const defPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${defPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${defDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
    const defPath = path.join(defDir, 'server.default.js');
    fs.writeFileSync(defPath, defPatched);

    // Simulate anonymous mode: NODE_ENV=development, no SCORE_API_KEY
    const defEnv = { ...process.env };
    delete defEnv.SCORE_API_KEY;
    defEnv.NODE_ENV = 'development';
    const defProc = spawn(process.execPath, [defPath], { stdio: 'pipe', env: defEnv });
    defProc.stderr.on('data', () => {});
    defProc.stdout.on('data', () => {});

    await waitForPort(defPort);

    // Full flow: challenge → POST → verify persisted
    const postRes = await postWithChallenge(defPort, { name: 'DefaultUser', score: 42 });
    assert.strictEqual(postRes.status, 201, 'Expected 201 for anonymous POST in default deployment');
    assert.ok(Array.isArray(postRes.body), 'Expected array response');
    assert.strictEqual(postRes.body[0].name, 'DefaultUser');
    assert.strictEqual(postRes.body[0].score, 42);

    // Verify GET returns the score
    const getRes = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: defPort, path: '/api/scores', method: 'GET' }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.body.length, 1);
    assert.strictEqual(getRes.body[0].name, 'DefaultUser');

    defProc.kill('SIGTERM');
    try { fs.rmSync(defDir, { recursive: true }); } catch {}
  });

  // --- Default Docker container startup path ---
  // Simulates the exact Docker default: NODE_ENV=production, ALLOW_ANONYMOUS_SCORES=false,
  // no SCORE_API_KEY. Verifies the API exits cleanly with an actionable error message
  // so operators know the leaderboard is disabled and how to enable it.
  await test('Default Docker path: exits with actionable error when no auth configured', async () => {
    const dockerPort = PORT + 8;
    const dockerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-docker-default-'));
    const dockerPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${dockerPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${dockerDir.replace(/\\/g, '/')}';`);
    const dockerPath = path.join(dockerDir, 'server.docker-default.js');
    fs.writeFileSync(dockerPath, dockerPatched);

    const dockerEnv = { ...process.env };
    delete dockerEnv.SCORE_API_KEY;
    dockerEnv.NODE_ENV = 'production';
    dockerEnv.ALLOW_ANONYMOUS_SCORES = 'false';
    const dockerProc = spawn(process.execPath, [dockerPath], {
      stdio: 'pipe',
      env: dockerEnv,
    });

    let stderrOutput = '';
    dockerProc.stderr.on('data', (d) => { stderrOutput += d.toString(); });
    dockerProc.stdout.on('data', () => {});

    const exitCode = await new Promise((resolve) => {
      dockerProc.on('exit', (code) => resolve(code));
    });
    assert.strictEqual(exitCode, 1, 'Expected exit code 1 for default Docker config');
    assert.ok(stderrOutput.includes('FATAL'), 'Expected FATAL error in stderr');
    assert.ok(stderrOutput.includes('SCORE_API_KEY'), 'Error should mention SCORE_API_KEY');
    assert.ok(stderrOutput.includes('ALLOW_ANONYMOUS_SCORES'), 'Error should mention ALLOW_ANONYMOUS_SCORES as alternative');

    try { fs.rmSync(dockerDir, { recursive: true }); } catch {}
  });

  await test('POST with server-rejected challenge does not modify scores', async () => {
    // Use main server — POST without a valid challenge token should return 403
    // and should NOT modify the score file
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), JSON.stringify([{ name: 'Existing', score: 100 }]), 'utf8');

    const res = await requestNoChallenge('POST', { name: 'Rejected', score: 999 }, { 'X-Challenge-Token': 'fake-token' });
    assert.strictEqual(res.status, 403, 'Expected 403 for invalid challenge token');

    // Verify scores unchanged
    const scores = await request('GET');
    assert.strictEqual(scores.body.length, 1, 'Score count should not change');
    assert.strictEqual(scores.body[0].name, 'Existing', 'Original score should remain');
    assert.strictEqual(scores.body[0].score, 100, 'Original score value should remain');
  });

  // Print results
  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);

  // Cleanup
  serverProcess.kill('SIGTERM');
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  if (serverProcess) serverProcess.kill('SIGTERM');
  if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  process.exit(1);
});
