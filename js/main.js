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
} from './renderer.js';

import { initTracker, calibrate, detectTilt, detectPitch, detectMouthOpen, resetTilt } from './tracker.js';
import { initPhysics, updatePhysics, resetBall, updateLevelData } from './physics.js';
import { getPointAtDistance } from './track.js';

const overlay = document.getElementById('overlay');
const overlayTitle = overlay.querySelector('.title');
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
const leaderboardPanel = document.getElementById('leaderboard-panel');
const leaderboardList = document.getElementById('leaderboard-list');
const leaderboardClose = document.getElementById('leaderboard-close');
const slowdownIndicator = document.getElementById('slowdown-indicator');
const boostIndicator = document.getElementById('boost-indicator');
const levelEl = document.getElementById('level');
const timerEl = document.getElementById('timer');
const retryBtn = document.getElementById('retry-btn');

const STORAGE_KEY = 'teeter_highscores';
const MAX_SCORES = 10;
const NON_QUALIFYING_DELAY = 2000;
const CHUNK_LENGTH = 20;

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
let finishTime = 0;

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

// --- localStorage leaderboard ---

function loadScores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => typeof e.name === 'string' && typeof e.score === 'number')
      .sort((a, b) => b.score - a.score).slice(0, MAX_SCORES);
  } catch { return []; }
}

function saveScores(scores) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scores)); } catch {}
}

function scoreQualifies(value) {
  if (value <= 0) return false;
  const scores = loadScores();
  if (scores.length < MAX_SCORES) return true;
  return value > scores[scores.length - 1].score;
}

function addScore(name, value) {
  const scores = loadScores();
  scores.push({ name, score: value });
  scores.sort((a, b) => b.score - a.score);
  const trimmed = scores.slice(0, MAX_SCORES);
  saveScores(trimmed);
  return trimmed;
}

function renderLeaderboard() {
  const scores = loadScores();
  if (scores.length === 0) {
    leaderboardList.innerHTML = '<p class="lb-empty">No scores yet.</p>';
    return;
  }
  let html = '<table><thead><tr><th class="lb-rank">#</th><th class="lb-name">Name</th><th class="lb-score">Score</th></tr></thead><tbody>';
  for (let i = 0; i < scores.length; i++) {
    const e = scores[i];
    const escapedName = e.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html += '<tr><td class="lb-rank">' + (i + 1) + '</td><td class="lb-name">' + escapedName + '</td><td class="lb-score">' + e.score + '</td></tr>';
  }
  html += '</tbody></table>';
  leaderboardList.innerHTML = html;
}

function showLeaderboard() { renderLeaderboard(); leaderboardPanel.classList.add('visible'); }
function hideLeaderboard() { leaderboardPanel.classList.remove('visible'); }

// --- Finish state ---

function enterFinished(timestamp) {
  finishTime = ((timestamp - gameStartTime) / 1000).toFixed(1);
  finalScore = score;
  state = 'finished';

  gameoverTitle.textContent = 'FINISHED!';
  gameoverScore.textContent = 'Score: ' + finalScore + '  |  Time: ' + finishTime + 's';

  if (scoreQualifies(finalScore)) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    nameInput.value = '';
    nameInput.focus();
  } else {
    gameoverMessage.textContent = 'Great run!';
    nameEntry.classList.remove('visible');
    resetTimer = setTimeout(() => { exitGameOver(); }, NON_QUALIFYING_DELAY);
  }

  levelEl.style.display = 'none';
  timerEl.style.display = 'none';
  gameoverOverlay.classList.add('visible');
}

// --- Game over flow ---

function enterGameOver() {
  finalScore = score;
  state = 'gameover';

  gameoverTitle.textContent = 'GAME OVER';
  gameoverScore.textContent = 'Score: ' + finalScore;

  if (scoreQualifies(finalScore)) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    nameInput.value = '';
    nameInput.focus();
  } else {
    gameoverMessage.textContent = '';
    nameEntry.classList.remove('visible');
    resetTimer = setTimeout(() => { exitGameOver(); }, NON_QUALIFYING_DELAY);
  }

  levelEl.style.display = 'none';
  timerEl.style.display = 'none';
  gameoverOverlay.classList.add('visible');
}

function submitScore() {
  let name = nameInput.value.trim();
  if (!name) name = 'Anonymous';
  addScore(name, finalScore);
  exitGameOver();
}

function exitGameOver() {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  gameoverOverlay.classList.remove('visible');
  nameEntry.classList.remove('visible');

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
leaderboardBtn.addEventListener('click', () => { showLeaderboard(); });
leaderboardClose.addEventListener('click', () => { hideLeaderboard(); });
leaderboardPanel.addEventListener('click', (e) => { if (e.target === leaderboardPanel) hideLeaderboard(); });

retryBtn.addEventListener('click', () => {
  location.reload();
});

// --- Init & game loop ---

async function doInit() {
  // WebGL pre-check
  const testCanvas = document.createElement('canvas');
  const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
  if (!gl) {
    showError('WebGL is not supported by your browser.\nPlease use a modern browser with WebGL enabled.');
    return;
  }

  // Initialize Three.js renderer
  initRenderer();
  const config = getTrackConfig();
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
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showError('Camera access was denied.\nPlease allow camera access and try again.');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      showError('No camera found.\nPlease connect a camera and try again.');
    } else {
      showError('Could not access camera.\n' + (err.message || 'Unknown error'));
    }
    return;
  }

  subtitle.textContent = 'Loading head tracking model...';

  // Initialize head tracker
  try {
    await initTracker(stream);
  } catch (err) {
    console.error('Tracker initialization failed:', err);
    showError('Failed to load head tracking model.\nPlease check your connection and try again.');
    return;
  }

  calibrate(performance.now());

  // If timeout already fired and showed an error, don't override it
  if (state === 'error') return;

  // Hide overlay, show score and leaderboard button, and start game
  overlay.classList.add('hidden');
  scoreEl.style.display = 'block';
  levelEl.style.display = 'block';
  timerEl.style.display = 'block';
  leaderboardBtn.style.display = 'block';
  updateScore(0);
  gameStartTime = performance.now();
  state = 'playing';
  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

async function init() {
  const INIT_TIMEOUT = 15000;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    showError('Loading timed out.\nPlease check your connection and try again.');
  }, INIT_TIMEOUT);

  try {
    await doInit();
  } catch (err) {
    console.error('Initialization error:', err);
    if (!timedOut) {
      showError('Failed to initialize.\nPlease reload and try again.');
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function showError(message) {
  state = 'error';
  overlay.classList.remove('hidden');
  overlay.classList.add('error');
  subtitle.textContent = message;
  overlayTitle.textContent = '';
  retryBtn.classList.add('visible');
}

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

    if (result.slowdownActive) { slowdownIndicator.classList.add('visible'); }
    else { slowdownIndicator.classList.remove('visible'); }

    if (result.boostActive) { boostIndicator.classList.add('visible'); }
    else { boostIndicator.classList.remove('visible'); }

    // Handle finish
    if (result.finished && state === 'playing') {
      enterFinished(timestamp);
    }

    // Handle falling
    if (result.falling && state === 'playing') { state = 'falling'; }
    if (result.needsReset && state === 'falling') { enterGameOver(); }
  }

  render();
}

init();
