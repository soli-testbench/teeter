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

function request(method, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/scores',
      method,
      headers: {},
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

async function run() {
  // Create temp data directory
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-test-'));

  // Patch the server to use our port and temp dir by writing a wrapper
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const patched = serverSrc
    .replace(/const PORT = \d+;/, `const PORT = ${PORT};`)
    .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${tmpDir.replace(/\\/g, '/')}';`)
    .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
    .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
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
    const bigBody = JSON.stringify({ name: 'X', score: 1, padding: 'A'.repeat(2048) });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: PORT, path: '/api/scores', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bigBody) },
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

    // Wait for RL server to start
    for (let i = 0; i < 20; i++) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.request({ hostname: '127.0.0.1', port: rlPort, path: '/api/scores', method: 'GET' }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          });
          req.on('error', reject);
          req.end();
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    let rateLimited = false;
    for (let i = 0; i < 6; i++) {
      const res = await new Promise((resolve, reject) => {
        const data = JSON.stringify({ name: `Flood${i}`, score: i + 1 });
        const req = http.request({
          hostname: '127.0.0.1', port: rlPort, path: '/api/scores', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (r) => {
          let chunks = '';
          r.on('data', (c) => (chunks += c));
          r.on('end', () => resolve({ status: r.statusCode }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
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

    // Wait for server to start
    for (let i = 0; i < 20; i++) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.request({ hostname: '127.0.0.1', port: akPort, path: '/api/scores', method: 'GET' }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          });
          req.on('error', reject);
          req.end();
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // POST without API key — should be rejected
    const noKeyRes = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'NoKey', score: 10 });
      const req = http.request({
        hostname: '127.0.0.1', port: akPort, path: '/api/scores', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => {
          let json; try { json = JSON.parse(chunks); } catch { json = chunks; }
          resolve({ status: r.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(noKeyRes.status, 401, 'Expected 401 without API key');

    // POST with wrong API key — should be rejected
    const wrongKeyRes = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'WrongKey', score: 10 });
      const req = http.request({
        hostname: '127.0.0.1', port: akPort, path: '/api/scores', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-API-Key': 'wrong-key',
        },
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => {
          let json; try { json = JSON.parse(chunks); } catch { json = chunks; }
          resolve({ status: r.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(wrongKeyRes.status, 401, 'Expected 401 with wrong API key');

    // POST with correct API key — should succeed
    const goodKeyRes = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'GoodKey', score: 10 });
      const req = http.request({
        hostname: '127.0.0.1', port: akPort, path: '/api/scores', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-API-Key': 'test-secret-key',
        },
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => {
          let json; try { json = JSON.parse(chunks); } catch { json = chunks; }
          resolve({ status: r.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(goodKeyRes.status, 201, 'Expected 201 with correct API key');

    akProc.kill('SIGTERM');
    try { fs.rmSync(akDir, { recursive: true }); } catch {}
  });

  // --- Production mode without API key (anonymous by design) ---
  await test('Server starts and accepts POST in production without SCORE_API_KEY', async () => {
    const prodPort = PORT + 3;
    const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-prod-'));
    const prodPatched = serverSrc
      .replace(/const PORT = \d+;/, `const PORT = ${prodPort};`)
      .replace(/const DATA_DIR = '[^']+';/, `const DATA_DIR = '${prodDir.replace(/\\/g, '/')}';`)
      .replace(/const RATE_LIMIT_MAX_POSTS = \d+;/, 'const RATE_LIMIT_MAX_POSTS = 100;')
      .replace(/const SCORE_COOLDOWN_MS = [\d* ]+;/, 'const SCORE_COOLDOWN_MS = 0;');
    const prodPath = path.join(prodDir, 'server.prod.js');
    fs.writeFileSync(prodPath, prodPatched);

    // Spawn with NODE_ENV=production and NO SCORE_API_KEY
    const prodEnv = { ...process.env };
    delete prodEnv.SCORE_API_KEY;
    prodEnv.NODE_ENV = 'production';
    const prodProc = spawn(process.execPath, [prodPath], {
      stdio: 'pipe',
      env: prodEnv,
    });
    prodProc.stderr.on('data', () => {});
    prodProc.stdout.on('data', () => {});

    // Wait for server to start
    let started = false;
    for (let i = 0; i < 20; i++) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.request({ hostname: '127.0.0.1', port: prodPort, path: '/api/health', method: 'GET' }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          });
          req.on('error', reject);
          req.end();
        });
        started = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(started, 'Server should start in production without SCORE_API_KEY');

    // POST should succeed (anonymous submission)
    const postRes = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'ProdUser', score: 55 });
      const req = http.request({
        hostname: '127.0.0.1', port: prodPort, path: '/api/scores', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => {
          let json; try { json = JSON.parse(chunks); } catch { json = chunks; }
          resolve({ status: r.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(postRes.status, 201, 'Expected 201 for anonymous POST in production');
    assert.ok(Array.isArray(postRes.body), 'Expected array response');
    assert.strictEqual(postRes.body[0].name, 'ProdUser');

    prodProc.kill('SIGTERM');
    try { fs.rmSync(prodDir, { recursive: true }); } catch {}
  });

  // --- Duplicate detection ---
  await test('POST with duplicate name+score returns 409', async () => {
    // Reset scores file with a known entry
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
  // Spawn a server with cooldown enabled to verify enforcement.
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

    for (let i = 0; i < 20; i++) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.request({ hostname: '127.0.0.1', port: cdPort, path: '/api/scores', method: 'GET' }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          });
          req.on('error', reject);
          req.end();
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // First POST — should succeed
    const first = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'CD1', score: 10 });
      const req = http.request({
        hostname: '127.0.0.1', port: cdPort, path: '/api/scores', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(first.status, 201, 'First POST should succeed');

    // Second POST — should be rejected by cooldown
    const second = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ name: 'CD2', score: 20 });
      const req = http.request({
        hostname: '127.0.0.1', port: cdPort, path: '/api/scores', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (r) => {
        let chunks = '';
        r.on('data', (c) => (chunks += c));
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.strictEqual(second.status, 429, 'Second POST should be rejected by cooldown');

    cdProc.kill('SIGTERM');
    try { fs.rmSync(cdDir, { recursive: true }); } catch {}
  });

  // --- Concurrent write integrity test ---
  await test('Concurrent POSTs do not lose updates', async () => {
    // Reset scores file to empty state
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), '[]', 'utf8');

    // Fire 10 concurrent POSTs with unique names
    const count = 10;
    const promises = [];
    for (let i = 0; i < count; i++) {
      promises.push(request('POST', { name: `Conc${i}`, score: (i + 1) * 10 }));
    }
    const results = await Promise.all(promises);

    // All should succeed (201)
    for (const r of results) {
      assert.strictEqual(r.status, 201, 'Expected 201 for concurrent POST');
    }

    // Read final state and verify all 10 unique names are present
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
    // Write a known score to disk
    const knownScores = [{ name: 'Persist', score: 999 }];
    fs.writeFileSync(path.join(tmpDir, 'scores.json'), JSON.stringify(knownScores), 'utf8');

    // Kill the running server (simulates a crash)
    serverProcess.kill('SIGKILL');
    await new Promise((r) => serverProcess.on('exit', r));

    // Restart the server (simulates start.sh restart loop)
    serverProcess = spawn(process.execPath, [patchedPath], { stdio: 'pipe' });
    serverProcess.stderr.on('data', () => {});
    serverProcess.stdout.on('data', () => {});
    await waitForServer();

    // Verify scores survived the crash
    const res = await request('GET');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.length >= 1, 'Expected at least one score after restart');
    assert.strictEqual(res.body[0].name, 'Persist');
    assert.strictEqual(res.body[0].score, 999);

    // Verify new submissions work after restart
    const post = await request('POST', { name: 'AfterCrash', score: 500 });
    assert.strictEqual(post.status, 201, 'Expected 201 for POST after crash recovery');
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
