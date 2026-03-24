import {
  initRenderer,
  updateBallPosition,
  updateBallRotation,
  resetBallRotation,
  updateCamera,
  render,
  getTrackConfig,
  updateRollingTrack,
  resetRollingTrack,
  getActiveObstacles,
  getActiveCoins,
  getActiveTurtles,
  hideCoinById,
  hideTurtleById,
  updateCoinRotation,
  updateSceneColors,
} from './renderer.js';

import { initTracker, calibrate, detectTilt, detectPitch, detectMouthOpen, resetTilt } from './tracker.js';
import { initPhysics, updatePhysics, resetBall, updateLevelData } from './physics.js';

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
const boostIndicator = document.getElementById('boost-indicator');
const levelEl = document.getElementById('level');

const STORAGE_KEY = 'teeter_highscores';
const MAX_SCORES = 10;
const NON_QUALIFYING_DELAY = 2000;
const CHUNK_LENGTH = 20;

// Deterministic background color palette per level
const LEVEL_COLORS = [
  0x87CEEB, // Level 1: sky blue (default)
  0xFFB347, // Level 2: warm orange
  0x77DD77, // Level 3: pastel green
  0xCB99C9, // Level 4: pastel purple
  0xFF6961, // Level 5: pastel red
  0xAEC6CF, // Level 6: pastel blue-gray
  0xFDFD96, // Level 7: pastel yellow
  0xB39EB5, // Level 8: pastel violet
  0x87CEFA, // Level 9: light sky blue
  0xFFDAB9, // Level 10: peach puff
];

let state = 'loading'; // loading | permission | playing | falling | gameover
let lastTime = 0;
let resetTimer = null;
let score = 0;
let finalScore = 0;
let currentBallZ = -20; // Track ball Z for rolling chunk updates
let currentLevel = 1;

function updateScore(value) {
  score = value;
  scoreEl.textContent = 'Score: ' + score;
}

function updateLevel(ballZ, ballStartZ) {
  const newLevel = Math.max(1, Math.floor((ballZ - ballStartZ) / CHUNK_LENGTH) + 1);
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
    return parsed
      .filter((e) => typeof e.name === 'string' && typeof e.score === 'number')
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SCORES);
  } catch {
    return [];
  }
}

function saveScores(scores) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
  } catch {
    // storage unavailable -- silently fail
  }
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

// --- Leaderboard panel ---

function renderLeaderboard() {
  const scores = loadScores();
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

function showLeaderboard() {
  renderLeaderboard();
  leaderboardPanel.classList.add('visible');
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

  levelEl.style.display = 'none';
  gameoverOverlay.classList.add('visible');
}

function submitScore() {
  let name = nameInput.value.trim();
  if (!name) name = 'Anonymous';
  addScore(name, finalScore);
  exitGameOver();
}

function exitGameOver() {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }

  gameoverOverlay.classList.remove('visible');
  nameEntry.classList.remove('visible');

  // Reset the rolling track and game state
  resetRollingTrack();
  const config = getTrackConfig();
  initPhysics(config);
  currentBallZ = config.ballStartZ;
  slowdownIndicator.classList.remove('visible');
  boostIndicator.classList.remove('visible');
  resetTilt();
  calibrate(performance.now());
  resetBallRotation();
  resetLevel();
  updateScore(0);
  levelEl.style.display = 'block';
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
    // Initialize Three.js renderer and rolling track
    initRenderer();
    const config = getTrackConfig();
    initPhysics(config);
    currentBallZ = config.ballStartZ;

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

      // Hide overlay, show score, level, and leaderboard button, and start game
      overlay.classList.add('hidden');
      scoreEl.style.display = 'block';
      levelEl.style.display = 'block';
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
    // Get head tilt, pitch, and mouth-open state
    const tiltAngle = detectTilt(timestamp);
    const pitch = detectPitch();
    const mouthOpen = detectMouthOpen();

    // Update rolling track chunks based on current ball position
    updateRollingTrack(currentBallZ);

    // Sync physics with active level data from visible chunks
    updateLevelData(getActiveObstacles(), getActiveCoins(), getActiveTurtles());

    // Update physics
    const result = updatePhysics(dt, tiltAngle, pitch, mouthOpen);
    currentBallZ = result.z;

    // Update level based on ball position
    if (state === 'playing') {
      const config = getTrackConfig();
      updateLevel(result.z, config.ballStartZ);
    }

    // Update renderer
    updateBallPosition(result.x, result.y, result.z);
    updateBallRotation(result.vx, result.vz, dt);
    updateCamera(result.z);

    // Animate coins
    updateCoinRotation(dt);

    // Handle coin collection
    if (result.coinsCollected && result.coinsCollected.length > 0) {
      for (const coinId of result.coinsCollected) {
        hideCoinById(coinId);
        updateScore(score + 1);
      }
    }

    // Handle turtle collection
    if (result.turtleCollected) {
      hideTurtleById(result.turtleCollected);
    }

    // Show/hide slowdown indicator
    if (result.slowdownActive) {
      slowdownIndicator.classList.add('visible');
    } else {
      slowdownIndicator.classList.remove('visible');
    }

    // Show/hide boost indicator
    if (result.boostActive) {
      boostIndicator.classList.add('visible');
    } else {
      boostIndicator.classList.remove('visible');
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
