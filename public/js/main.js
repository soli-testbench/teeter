import {
  initRenderer,
  updateBallPosition,
  updateBallRotation,
  resetBallRotation,
  updateCamera,
  render,
  getTrackConfig,
  resetTrack,
  getActiveObstacles,
  getActiveCoins,
  getActiveTurtles,
  hideCoinById,
  hideTurtleById,
  updateCoinRotation,
  updateSceneColors,
  updateMovingWalls,
  updateChunks,
} from './renderer.js';

import { initTracker, calibrate, detectTilt, detectPitch, detectMouthOpen, resetTilt } from './tracker.js';
import { initPhysics, updatePhysics, resetBall, updateLevelData, setSensitivity, getSensitivity, DEFAULT_SENSITIVITY } from './physics.js';
import { getPointAtDistance } from './track.js';

const overlay = document.getElementById('overlay');
const subtitle = overlay.querySelector('.subtitle');
const scoreEl = document.getElementById('score');
const leaderboardBtn = document.getElementById('leaderboard-btn');
const gameoverOverlay = document.getElementById('gameover-overlay');
const gameoverTitle = gameoverOverlay.querySelector('.go-title');
const gameoverScore = gameoverOverlay.querySelector('.go-score');
const gameoverMessage = gameoverOverlay.querySelector('.go-message');
const nameEntry = document.getElementById('name-entry');
const nameInput = document.getElementById('name-input');
const nameSubmit = document.getElementById('name-submit');
const playAgainBtn = document.getElementById('play-again-btn');
const leaderboardPanel = document.getElementById('leaderboard-panel');
const leaderboardList = document.getElementById('leaderboard-list');
const leaderboardClose = document.getElementById('leaderboard-close');
const slowdownIndicator = document.getElementById('slowdown-indicator');
const boostIndicator = document.getElementById('boost-indicator');
const levelEl = document.getElementById('level');
const timerEl = document.getElementById('timer');
const retryBtn = document.getElementById('retry-btn');
const speedEl = document.getElementById('speed');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const sensitivitySlider = document.getElementById('sensitivity-slider');
const sensitivityValue = document.getElementById('sensitivity-value');
const sensitivityReset = document.getElementById('sensitivity-reset');

const INIT_TIMEOUT_MS = 15000;

const SENSITIVITY_STORAGE_KEY = 'teeter_sensitivity';
const PLAYER_NAME_STORAGE_KEY = 'teeter_player_name';
const MAX_SCORES = 10;
const NON_QUALIFYING_DELAY = 2000;
const CHUNK_LENGTH = 20;
const API_BASE = '/api';

const LEVEL_COLORS = [
  0x87CEEB, 0xFFB347, 0x77DD77, 0xCB99C9, 0xFF6961,
  0xAEC6CF, 0xFDFD96, 0xB39EB5, 0x87CEFA, 0xFFDAB9,
];

let state = 'loading';
let lastTime = 0;
let resetTimer = null;
let score = 0;
let finalScore = 0;
let currentLevel = 1;
let gameStartTime = 0;
let rendererInitialized = false;

// Cached leaderboard scores for rendering
let cachedScores = [];

function updateScore(value) {
  score = value;
  scoreEl.textContent = 'Score: ' + score;
}

function updateTimer(timestamp) {
  if (state !== 'playing') return;
  const elapsed = (timestamp - gameStartTime) / 1000;
  const mins = Math.floor(elapsed / 60);
  const secs = Math.floor(elapsed % 60);
  timerEl.textContent = mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
}

function updateLevel(ballDistance) {
  const newLevel = Math.max(1, Math.floor(ballDistance / CHUNK_LENGTH) + 1);
  if (newLevel !== currentLevel) {
    currentLevel = newLevel;
    levelEl.textContent = 'Level ' + currentLevel;
    const colorIndex = (currentLevel - 1) % LEVEL_COLORS.length;
    updateSceneColors(LEVEL_COLORS[colorIndex]);
  }
}

function resetLevel() {
  currentLevel = 1;
  levelEl.textContent = 'Level 1';
  updateSceneColors(LEVEL_COLORS[0]);
}

// --- Sensitivity settings ---

function getSensitivityLabel(val) {
  if (val <= 11.5) return 'Low';
  if (val <= 19.5) return 'Medium';
  return 'High';
}

function updateSensitivityDisplay(val) {
  sensitivityValue.textContent = parseFloat(val).toFixed(1) + ' (' + getSensitivityLabel(val) + ')';
  sensitivitySlider.value = val;
}

function loadSensitivity() {
  try {
    const stored = localStorage.getItem(SENSITIVITY_STORAGE_KEY);
    if (stored !== null) {
      const val = parseFloat(stored);
      if (!isNaN(val) && val >= 5 && val <= 30) {
        setSensitivity(val);
        updateSensitivityDisplay(val);
        return;
      }
    }
  } catch {}
  setSensitivity(DEFAULT_SENSITIVITY);
  updateSensitivityDisplay(DEFAULT_SENSITIVITY);
}

function saveSensitivity(val) {
  try { localStorage.setItem(SENSITIVITY_STORAGE_KEY, String(val)); } catch {}
}

// --- Player name persistence ---

function loadPlayerName() {
  try {
    return localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || '';
  } catch { return ''; }
}

function savePlayerName(name) {
  try { localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name); } catch {}
}

function showSettings() { settingsPanel.classList.add('visible'); }
function hideSettings() { settingsPanel.classList.remove('visible'); }

sensitivitySlider.addEventListener('input', () => {
  const val = parseFloat(sensitivitySlider.value);
  setSensitivity(val);
  updateSensitivityDisplay(val);
  saveSensitivity(val);
});

sensitivityReset.addEventListener('click', () => {
  setSensitivity(DEFAULT_SENSITIVITY);
  updateSensitivityDisplay(DEFAULT_SENSITIVITY);
  saveSensitivity(DEFAULT_SENSITIVITY);
});

settingsBtn.addEventListener('click', () => { showSettings(); });
settingsClose.addEventListener('click', () => { hideSettings(); });
settingsPanel.addEventListener('click', (e) => { if (e.target === settingsPanel) hideSettings(); });

// --- API-based leaderboard ---

async function fetchScores() {
  try {
    const res = await fetch(API_BASE + '/scores');
    if (!res.ok) throw new Error('Server error: ' + res.status);
    const data = await res.json();
    cachedScores = data.scores || [];
    return { scores: cachedScores, offline: false };
  } catch (err) {
    console.error('Failed to fetch scores:', err);
    return { scores: cachedScores, offline: true };
  }
}

async function scoreQualifies(value) {
  if (value <= 0) return false;
  try {
    const res = await fetch(API_BASE + '/scores/qualifies?score=' + encodeURIComponent(value));
    if (!res.ok) throw new Error('Server error: ' + res.status);
    const data = await res.json();
    return data.qualifies;
  } catch (err) {
    console.error('Failed to check score qualification:', err);
    // Fallback: use cached scores
    if (cachedScores.length < MAX_SCORES) return true;
    return value > cachedScores[cachedScores.length - 1].score;
  }
}

async function addScore(name, value) {
  try {
    const res = await fetch(API_BASE + '/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score: value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Server error: ' + res.status);
    }
    const data = await res.json();
    if (data.scores) {
      cachedScores = data.scores;
    }
    return { success: true };
  } catch (err) {
    console.error('Failed to submit score:', err);
    return { success: false, error: err.message };
  }
}

function renderLeaderboard(scores, offline) {
  leaderboardList.textContent = '';

  if (!scores || scores.length === 0) {
    const p = document.createElement('p');
    p.className = 'lb-empty';
    p.textContent = offline
      ? 'Could not reach server. Please try again later.'
      : 'No scores yet.';
    leaderboardList.appendChild(p);
    return;
  }

  if (offline) {
    const p = document.createElement('p');
    p.className = 'lb-empty';
    p.textContent = 'Could not reach server. Showing cached scores.';
    leaderboardList.appendChild(p);
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [cls, label] of [['lb-rank', '#'], ['lb-name', 'Name'], ['lb-score', 'Score']]) {
    const th = document.createElement('th');
    th.className = cls;
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let i = 0; i < scores.length; i++) {
    const row = document.createElement('tr');
    const rankTd = document.createElement('td');
    rankTd.className = 'lb-rank';
    rankTd.textContent = String(i + 1);
    const nameTd = document.createElement('td');
    nameTd.className = 'lb-name';
    nameTd.textContent = scores[i].name;
    const scoreTd = document.createElement('td');
    scoreTd.className = 'lb-score';
    scoreTd.textContent = String(scores[i].score);
    row.appendChild(rankTd);
    row.appendChild(nameTd);
    row.appendChild(scoreTd);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  leaderboardList.appendChild(table);
}

async function showLeaderboard() {
  leaderboardList.textContent = '';
  const loadingP = document.createElement('p');
  loadingP.className = 'lb-empty';
  loadingP.textContent = 'Loading scores...';
  leaderboardList.appendChild(loadingP);
  leaderboardPanel.classList.add('visible');
  const { scores, offline } = await fetchScores();
  renderLeaderboard(scores, offline);
}

function hideLeaderboard() { leaderboardPanel.classList.remove('visible'); }

// --- Game over flow ---

async function enterGameOver() {
  finalScore = score;
  state = 'gameover';

  gameoverTitle.textContent = 'GAME OVER';
  gameoverScore.textContent = 'Score: ' + finalScore;
  gameoverMessage.textContent = 'Checking score...';
  nameEntry.classList.remove('visible');

  levelEl.style.display = 'none';
  timerEl.style.display = 'none';
  speedEl.style.display = 'none';
  playAgainBtn.classList.remove('visible');
  gameoverOverlay.classList.add('visible');

  const qualifies = await scoreQualifies(finalScore);
  if (qualifies) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    playAgainBtn.classList.add('visible');
    const savedName = loadPlayerName();
    nameInput.value = savedName;
    nameInput.focus();
    if (savedName) {
      nameInput.select();
    }
  } else {
    gameoverMessage.textContent = 'Restarting...';
    nameEntry.classList.remove('visible');
    playAgainBtn.classList.add('visible');
    resetTimer = setTimeout(() => { exitGameOver(); }, NON_QUALIFYING_DELAY);
  }
}

async function submitScore() {
  let name = nameInput.value.trim();
  if (!name) name = 'Anonymous';
  savePlayerName(name);
  nameSubmit.disabled = true;
  nameSubmit.textContent = 'Submitting...';
  const result = await addScore(name, finalScore);
  nameSubmit.disabled = false;
  nameSubmit.textContent = 'Submit';
  if (!result.success) {
    gameoverMessage.textContent = 'Failed to submit score. Please try again.';
    return;
  }
  exitGameOver();
}

function exitGameOver() {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  gameoverOverlay.classList.remove('visible');
  nameEntry.classList.remove('visible');
  playAgainBtn.classList.remove('visible');

  resetTrack();
  const config = getTrackConfig();
  initPhysics(config);
  slowdownIndicator.classList.remove('visible');
  boostIndicator.classList.remove('visible');
  resetTilt();
  calibrate(performance.now());
  resetBallRotation();
  resetLevel();
  updateScore(0);
  levelEl.style.display = 'block';
  timerEl.style.display = 'block';
  speedEl.style.display = 'block';

  const startPos = getStartBallPosition(config);
  updateBallPosition(startPos.x, startPos.y, startPos.z);
  updateCamera(config.ballStartDistance, startPos.x, startPos.y, startPos.z);
  gameStartTime = performance.now();
  state = 'playing';
}

function getStartBallPosition(config) {
  const p = getPointAtDistance(config.ballStartDistance);
  return { x: p.x, y: p.y + config.trackHeight / 2 + config.ballRadius, z: p.z };
}

// --- Event listeners ---

nameSubmit.addEventListener('click', () => { submitScore(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitScore(); });
playAgainBtn.addEventListener('click', () => { exitGameOver(); });
leaderboardBtn.addEventListener('click', () => { showLeaderboard(); });
leaderboardClose.addEventListener('click', () => { hideLeaderboard(); });
leaderboardPanel.addEventListener('click', (e) => { if (e.target === leaderboardPanel) hideLeaderboard(); });

// --- Init & game loop ---

function createInitTimeout() {
  let timeoutId;
  const promise = new Promise(function(_, reject) {
    timeoutId = setTimeout(function() {
      reject(new Error('INIT_TIMEOUT'));
    }, INIT_TIMEOUT_MS);
  });
  return { promise: promise, cancel: function() { clearTimeout(timeoutId); } };
}

async function init() {
  // Check WebGL support before anything else
  var testCanvas = document.createElement('canvas');
  var gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
  if (!gl) {
    showError('WebGL is not supported by your browser.\nPlease use a modern browser with WebGL enabled.', true);
    return;
  }

  var timeout = createInitTimeout();
  var stream;

  try {
    if (!rendererInitialized) {
      initRenderer();
      rendererInitialized = true;
    }
    var config = getTrackConfig();
    initPhysics(config);

    render();

    // Pre-fetch leaderboard scores
    fetchScores();

    // Request camera access
    subtitle.textContent = 'Requesting camera access...';

    try {
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        }),
        timeout.promise,
      ]);
    } catch (err) {
      timeout.cancel();
      if (err.message === 'INIT_TIMEOUT') {
        showError('Loading timed out.\nPlease check your connection and try again.', true);
      } else {
        showError('Camera access is required to play.\nPlease allow camera access and reload.', true);
      }
      return;
    }

    // Load MediaPipe face landmark model
    subtitle.textContent = 'Loading head tracking model...';
    try {
      await Promise.race([
        initTracker(stream),
        timeout.promise,
      ]);
    } catch (err) {
      timeout.cancel();
      // Stop camera stream to free resources on failure
      stream.getTracks().forEach(function(t) { t.stop(); });
      if (err.message === 'INIT_TIMEOUT') {
        showError('Loading timed out.\nPlease check your connection and try again.', true);
      } else {
        console.error('Tracker initialization error:', err);
        showError('Failed to load face tracking model.\nPlease check your connection and try again.', true);
      }
      return;
    }

    timeout.cancel();
    calibrate(performance.now());

    loadSensitivity();

    overlay.classList.add('hidden');
    retryBtn.classList.remove('visible');
    scoreEl.style.display = 'block';
    levelEl.style.display = 'block';
    timerEl.style.display = 'block';
    speedEl.style.display = 'block';
    leaderboardBtn.style.display = 'block';
    settingsBtn.style.display = 'block';
    updateScore(0);
    gameStartTime = performance.now();
    state = 'playing';
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
  } catch (err) {
    timeout.cancel();
    // Stop camera stream if it was acquired before the error
    if (stream) {
      stream.getTracks().forEach(function(t) { t.stop(); });
    }
    console.error('Initialization error:', err);
    showError('Failed to initialize.\nPlease reload and try again.', true);
    return;
  }
}

function showError(message, showRetry) {
  state = 'error';
  overlay.classList.remove('hidden');
  overlay.classList.add('error');
  subtitle.textContent = message;
  overlay.querySelector('.title').textContent = '';
  if (showRetry) {
    retryBtn.classList.add('visible');
  } else {
    retryBtn.classList.remove('visible');
  }
}

retryBtn.addEventListener('click', function() {
  retryBtn.classList.remove('visible');
  overlay.classList.remove('error');
  overlay.querySelector('.title').textContent = 'TEETER';
  subtitle.textContent = 'Loading...';
  state = 'loading';
  init();
});

function gameLoop(timestamp) {
  requestAnimationFrame(gameLoop);

  const dt = Math.min((timestamp - lastTime) / 1000, 1 / 30);
  lastTime = timestamp;

  if (state === 'playing' || state === 'falling') {
    const tiltAngle = detectTilt(timestamp);
    const pitch = detectPitch();
    const mouthOpen = detectMouthOpen();

    updateLevelData(getActiveObstacles(), getActiveCoins(), getActiveTurtles());

    const result = updatePhysics(dt, tiltAngle, pitch, mouthOpen);

    if (state === 'playing') {
      updateLevel(result.distance);
      updateTimer(timestamp);
      // Generate new track chunks and cull old ones
      updateChunks(result.distance);
    }

    updateBallPosition(result.x, result.y, result.z);
    updateBallRotation(result.vx, result.vz, dt);
    updateCamera(result.distance, result.x, result.y, result.z);
    updateCoinRotation(dt);
    updateMovingWalls(timestamp);

    if (result.coinsCollected && result.coinsCollected.length > 0) {
      for (const coinId of result.coinsCollected) {
        hideCoinById(coinId);
        updateScore(score + 1);
      }
    }

    if (result.turtleCollected) { hideTurtleById(result.turtleCollected); }

    // Update speed indicator
    const speed = Math.sqrt(result.vx * result.vx + result.vz * result.vz);
    speedEl.textContent = 'Speed: ' + speed.toFixed(1) + ' m/s';

    if (result.slowdownActive) { slowdownIndicator.classList.add('visible'); }
    else { slowdownIndicator.classList.remove('visible'); }

    if (result.boostActive) { boostIndicator.classList.add('visible'); }
    else { boostIndicator.classList.remove('visible'); }

    // Handle falling — game over only when ball falls off track
    if (result.falling && state === 'playing') { state = 'falling'; }
    if (result.needsReset && state === 'falling') { enterGameOver(); }
  }

  render();
}

init();
