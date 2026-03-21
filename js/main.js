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
const timerEl = document.getElementById('timer');
const leaderboardBtn = document.getElementById('leaderboard-btn');
const gameoverOverlay = document.getElementById('gameover-overlay');
const gameoverTitle = gameoverOverlay.querySelector('.go-title');
const gameoverScore = gameoverOverlay.querySelector('.go-score');
const gameoverMessage = gameoverOverlay.querySelector('.go-message');
const gameoverTime = gameoverOverlay.querySelector('.go-time');
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
const FINISH_DISPLAY_DELAY = 3000;

let state = 'loading'; // loading | permission | playing | falling | finished | gameover
let lastTime = 0;
let resetTimer = null;
let score = 0;
let finalScore = 0;
let runStartTime = 0;
let runElapsed = 0;

function updateScore(value) {
  score = value;
  scoreEl.textContent = 'Score: ' + score;
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  if (mins > 0) {
    return mins + ':' + String(secs).padStart(2, '0') + '.' + ms;
  }
  return secs + '.' + ms + 's';
}

function updateTimerDisplay() {
  timerEl.textContent = formatTime(runElapsed);
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
    // storage unavailable
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

// --- Finish & Game over flow ---

function enterFinished() {
  finalScore = score;
  state = 'finished';

  gameoverTitle.textContent = 'COURSE COMPLETE!';
  gameoverScore.textContent = 'Score: ' + finalScore;
  gameoverTime.textContent = 'Time: ' + formatTime(runElapsed);

  if (scoreQualifies(finalScore)) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    nameInput.value = '';
    nameInput.focus();
  } else {
    gameoverMessage.textContent = 'Well done!';
    nameEntry.classList.remove('visible');
    resetTimer = setTimeout(() => {
      exitGameOver();
    }, FINISH_DISPLAY_DELAY);
  }

  gameoverOverlay.classList.add('visible');
}

function enterGameOver() {
  finalScore = score;
  state = 'gameover';

  gameoverTitle.textContent = 'GAME OVER';
  gameoverScore.textContent = 'Score: ' + finalScore;
  gameoverTime.textContent = 'Time: ' + formatTime(runElapsed);

  if (scoreQualifies(finalScore)) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    nameInput.value = '';
    nameInput.focus();
  } else {
    gameoverMessage.textContent = '';
    nameEntry.classList.remove('visible');
    resetTimer = setTimeout(() => {
      exitGameOver();
    }, NON_QUALIFYING_DELAY);
  }

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

  // Reset ball to start of curve
  const startPos = config.curveLocalToWorld(0, 0, config.ballRadius);
  updateBallPosition(startPos.x, startPos.y, startPos.z);
  updateCamera(0, startPos);

  runStartTime = performance.now();
  runElapsed = 0;
  updateTimerDisplay();
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

leaderboardPanel.addEventListener('click', (e) => {
  if (e.target === leaderboardPanel) {
    hideLeaderboard();
  }
});

// --- Init & game loop ---

async function init() {
  try {
    initRenderer();
    const config = getTrackConfig();

    config.obstacles = getObstacles();
    config.coins = getCoins();
    config.turtle = getTurtle();
    initPhysics(config);

    render();

    subtitle.textContent = 'Requesting camera access...';

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

    await initTracker(stream);

    // Calibrate neutral head position
    calibrate(performance.now());

    // Hide overlay, show score and leaderboard button, and start game
    overlay.classList.add('hidden');
    scoreEl.style.display = 'block';
    timerEl.style.display = 'block';
    leaderboardBtn.style.display = 'block';
    updateScore(0);
    runStartTime = performance.now();
    runElapsed = 0;
    updateTimerDisplay();
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
    // Update run timer
    runElapsed = (timestamp - runStartTime) / 1000;
    updateTimerDisplay();

    const tiltAngle = detectTilt(timestamp);
    const pitch = detectPitch();

    const result = updatePhysics(dt, tiltAngle, pitch);

    updateBallPosition(result.x, result.y, result.z);
    updateBallRotation(result.vx, result.vz, dt);

    // Camera follows curve tangent at ball's t position
    const ballWorldPos = { x: result.x, y: result.y, z: result.z };
    updateCamera(result.t, ballWorldPos);

    updateCoinRotation(dt);

    if (result.coinsCollected && result.coinsCollected.length > 0) {
      for (const idx of result.coinsCollected) {
        hideCoin(idx);
        updateScore(score + 1);
      }
    }

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

    // Handle finish line crossing
    if (result.finished && state === 'playing') {
      enterFinished();
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
