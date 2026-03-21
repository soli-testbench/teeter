import {
  initRenderer,
  updateBallPosition,
  updateBallRotation,
  resetBallRotation,
  updateCamera,
  render,
  getTrackConfig,
  getObstacles,
  getCoins,
  hideCoin,
  showAllCoins,
  updateCoinRotation,
  regenerateLevel,
  getTurtle,
  hideTurtle,
} from './renderer.js';

import { initTracker, calibrate, detectTilt, detectPitch, resetTilt } from './tracker.js';
import { initPhysics, updatePhysics, resetBall, refreshLevel } from './physics.js';

const overlay = document.getElementById('overlay');
const subtitle = overlay.querySelector('.subtitle');
const scoreEl = document.getElementById('score');
const leaderboardBtn = document.getElementById('leaderboard-btn');
const gameoverOverlay = document.getElementById('gameover-overlay');
const gameoverScore = gameoverOverlay.querySelector('.go-score');
const gameoverMessage = gameoverOverlay.querySelector('.go-message');
const nameEntry = document.getElementById('name-entry');
const nameInput = document.getElementById('name-input');
const nameSubmit = document.getElementById('name-submit');
const leaderboardPanel = document.getElementById('leaderboard-panel');
const leaderboardList = document.getElementById('leaderboard-list');
const leaderboardClose = document.getElementById('leaderboard-close');
const slowdownIndicator = document.getElementById('slowdown-indicator');

const STORAGE_KEY = 'teeter_highscores';
const MAX_SCORES = 10;
const NON_QUALIFYING_DELAY = 2000;

let state = 'loading'; // loading | permission | playing | falling | gameover
let lastTime = 0;
let resetTimer = null;
let score = 0;
let finalScore = 0;

function updateScore(value) {
  score = value;
  scoreEl.textContent = 'Score: ' + score;
}

// --- Leaderboard with API + localStorage fallback ---

const API_TIMEOUT = 2000;
let cachedScores = [];

function loadLocalScores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => typeof e.name === 'string' && typeof e.score === 'number')
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SCORES);
  } catch {
    return [];
  }
}

function saveLocalScores(scores) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
  } catch {
    // storage unavailable — silently fail
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function loadScoresAsync() {
  try {
    const res = await fetchWithTimeout('/api/scores');
    if (!res.ok) {
      // Server explicitly returned an error — do not fall back to localStorage
      // since the server is reachable but rejecting requests (e.g. auth failure).
      // Return cached scores if available, otherwise empty.
      console.warn('Scores API returned', res.status);
      return cachedScores.length ? cachedScores : [];
    }
    const scores = await res.json();
    if (Array.isArray(scores)) {
      cachedScores = scores;
      saveLocalScores(scores);
      return scores;
    }
  } catch {
    // Network/timeout error — API unreachable, fall back to localStorage
  }
  const local = loadLocalScores();
  cachedScores = local;
  return local;
}

async function addScoreAsync(name, value) {
  let serverReachable = false;
  try {
    // Obtain a one-time challenge token before submitting (write integrity)
    const challengeRes = await fetchWithTimeout('/api/challenge');
    serverReachable = true;
    if (!challengeRes.ok) {
      // Server explicitly rejected the challenge request (e.g. 429 rate limit).
      // Do NOT fall back to localStorage — honour server-side controls.
      // Return serverRejected: true so the caller can inform the user.
      console.warn('Challenge rejected by server:', challengeRes.status);
      return { scores: cachedScores.length ? cachedScores : [], serverRejected: true, status: challengeRes.status };
    }
    const { token } = await challengeRes.json();

    const res = await fetchWithTimeout('/api/scores', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Challenge-Token': token,
      },
      body: JSON.stringify({ name, score: value }),
    });
    if (!res.ok) {
      // Server explicitly rejected the submission (4xx/5xx) — do not fall back
      // to local storage, as that would weaken server-enforced integrity
      // (e.g. rate limiting, auth, duplicate detection).
      // Return serverRejected with status so the caller can inform the user.
      console.warn('Score submission rejected by server:', res.status);
      return { scores: cachedScores.length ? cachedScores : [], serverRejected: true, status: res.status };
    }
    const scores = await res.json();
    if (Array.isArray(scores)) {
      cachedScores = scores;
      saveLocalScores(scores);
      return { scores, serverRejected: false };
    }
  } catch {
    // Network/timeout error — API unreachable
    if (serverReachable) {
      // Server was reachable but the POST failed unexpectedly (e.g. JSON parse
      // error on response). Treat as server-side issue, don't bypass to local.
      return { scores: cachedScores.length ? cachedScores : [], serverRejected: true, status: 0 };
    }
    // Server genuinely unreachable — fall back to localStorage
  }
  const scores = loadLocalScores();
  scores.push({ name, score: value });
  scores.sort((a, b) => b.score - a.score);
  const trimmed = scores.slice(0, MAX_SCORES);
  saveLocalScores(trimmed);
  cachedScores = trimmed;
  return { scores: trimmed, serverRejected: false };
}

function scoreQualifies(value) {
  if (value <= 0) return false;
  const scores = cachedScores.length ? cachedScores : loadLocalScores();
  if (scores.length < MAX_SCORES) return true;
  return value > scores[scores.length - 1].score;
}

// --- Leaderboard panel ---

async function renderLeaderboard() {
  const scores = await loadScoresAsync();
  if (scores.length === 0) {
    leaderboardList.innerHTML = '<p class="lb-empty">No scores yet.</p>';
    return;
  }
  let html = '<table><thead><tr>';
  html += '<th class="lb-rank">#</th>';
  html += '<th class="lb-name">Name</th>';
  html += '<th class="lb-score">Score</th>';
  html += '</tr></thead><tbody>';
  for (let i = 0; i < scores.length; i++) {
    const e = scores[i];
    const escapedName = e.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html += '<tr>';
    html += '<td class="lb-rank">' + (i + 1) + '</td>';
    html += '<td class="lb-name">' + escapedName + '</td>';
    html += '<td class="lb-score">' + e.score + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  leaderboardList.innerHTML = html;
}

async function showLeaderboard() {
  leaderboardPanel.classList.add('visible');
  await renderLeaderboard();
}

function hideLeaderboard() {
  leaderboardPanel.classList.remove('visible');
}

// --- Game over flow ---

function enterGameOver() {
  finalScore = score;
  state = 'gameover';

  gameoverScore.textContent = 'Score: ' + finalScore;

  if (scoreQualifies(finalScore)) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    nameInput.value = '';
    nameInput.focus();
  } else {
    gameoverMessage.textContent = '';
    nameEntry.classList.remove('visible');
    // Auto-dismiss after delay
    resetTimer = setTimeout(() => {
      exitGameOver();
    }, NON_QUALIFYING_DELAY);
  }

  gameoverOverlay.classList.add('visible');
}

async function submitScore() {
  let name = nameInput.value.trim();
  if (!name) name = 'Anonymous';
  nameSubmit.disabled = true;
  const result = await addScoreAsync(name, finalScore);
  nameSubmit.disabled = false;
  if (result.serverRejected) {
    // Inform the user that the server rejected their score submission.
    // Differentiate auth failures from other rejections so operators can
    // diagnose SCORE_API_KEY / NODE_ENV misconfiguration.
    if (result.status === 401) {
      gameoverMessage.textContent = 'Score not saved (authentication required).';
    } else if (result.status === 429) {
      gameoverMessage.textContent = 'Score not saved (too many attempts).';
    } else {
      gameoverMessage.textContent = 'Score not saved (server rejected).';
    }
  }
  exitGameOver();
}

function exitGameOver() {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }

  gameoverOverlay.classList.remove('visible');
  nameEntry.classList.remove('visible');

  // Reset the game
  regenerateLevel();
  const config = getTrackConfig();
  config.obstacles = getObstacles();
  config.coins = getCoins();
  config.turtle = getTurtle();
  initPhysics(config);
  slowdownIndicator.classList.remove('visible');
  resetTilt();
  calibrate(performance.now());
  resetBallRotation();
  updateScore(0);
  updateBallPosition(0, config.trackHeight / 2 + config.ballRadius, config.ballStartZ);
  updateCamera(config.ballStartZ);
  state = 'playing';
}

// --- Event listeners ---

nameSubmit.addEventListener('click', () => {
  submitScore();
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submitScore();
  }
});

leaderboardBtn.addEventListener('click', () => {
  showLeaderboard();
});

leaderboardClose.addEventListener('click', () => {
  hideLeaderboard();
});

// Close leaderboard on backdrop click
leaderboardPanel.addEventListener('click', (e) => {
  if (e.target === leaderboardPanel) {
    hideLeaderboard();
  }
});

// --- Init & game loop ---

async function init() {
  try {
    // Initialize Three.js renderer
    initRenderer();
    const config = getTrackConfig();

    // Attach obstacle, coin, and turtle data to config for physics
    config.obstacles = getObstacles();
    config.coins = getCoins();
    config.turtle = getTurtle();
    initPhysics(config);

    // Initial render so the scene is visible during loading
    render();

    subtitle.textContent = 'Requesting camera access...';

    // Request camera
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (err) {
      showError('Camera access is required to play.\nPlease allow camera access and reload.');
      return;
    }

    subtitle.textContent = 'Loading head tracking model...';

    // Initialize head tracker
    await initTracker(stream);

    // Calibrate neutral head position
    calibrate(performance.now());

    // Pre-load scores so cachedScores is available for scoreQualifies
    loadScoresAsync().catch(() => {});

    // Hide overlay, show score and leaderboard button, and start game
    overlay.classList.add('hidden');
    scoreEl.style.display = 'block';
    leaderboardBtn.style.display = 'block';
    updateScore(0);
    state = 'playing';
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
  } catch (err) {
    console.error('Initialization error:', err);
    showError('Failed to initialize. Please reload and try again.');
  }
}

function showError(message) {
  state = 'error';
  overlay.classList.add('error');
  subtitle.textContent = message;
  overlay.querySelector('.title').textContent = '';
}

function gameLoop(timestamp) {
  requestAnimationFrame(gameLoop);

  const dt = Math.min((timestamp - lastTime) / 1000, 1 / 30);
  lastTime = timestamp;

  if (state === 'playing' || state === 'falling') {
    // Get head tilt and pitch
    const tiltAngle = detectTilt(timestamp);
    const pitch = detectPitch();

    // Update physics
    const result = updatePhysics(dt, tiltAngle, pitch);

    // Update renderer
    updateBallPosition(result.x, result.y, result.z);
    updateBallRotation(result.vx, result.vz, dt);
    updateCamera(result.z);

    // Animate coins
    updateCoinRotation(dt);

    // Handle coin collection
    if (result.coinsCollected && result.coinsCollected.length > 0) {
      for (const idx of result.coinsCollected) {
        hideCoin(idx);
        updateScore(score + 1);
      }
    }

    // Handle turtle collection
    if (result.turtleCollected) {
      hideTurtle();
    }

    // Show/hide slowdown indicator
    if (result.slowdownActive) {
      slowdownIndicator.classList.add('visible');
    } else {
      slowdownIndicator.classList.remove('visible');
    }

    // Handle track completion — regenerate level with fresh coins
    if (result.trackCompleted) {
      regenerateLevel();
      const config = getTrackConfig();
      config.obstacles = getObstacles();
      config.coins = getCoins();
      config.turtle = getTurtle();
      initPhysics(config);
      resetBallRotation();
      slowdownIndicator.classList.remove('visible');
      updateBallPosition(0, config.trackHeight / 2 + config.ballRadius, config.ballStartZ);
      updateCamera(config.ballStartZ);
    }

    // Handle state transitions
    if (result.falling && state === 'playing') {
      state = 'falling';
    }

    if (result.needsReset && state === 'falling') {
      enterGameOver();
    }
  }

  render();
}

init();
