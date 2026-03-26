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
let finishTime = 0;

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

// --- Finish state ---

async function enterFinished(timestamp) {
  finishTime = ((timestamp - gameStartTime) / 1000).toFixed(1);
  finalScore = score;
  state = 'finished';

  gameoverTitle.textContent = 'FINISHED!';
  gameoverScore.textContent = 'Score: ' + finalScore + '  |  Time: ' + finishTime + 's';
  gameoverMessage.textContent = 'Checking score...';
  nameEntry.classList.remove('visible');

  levelEl.style.display = 'none';
  timerEl.style.display = 'none';
  gameoverOverlay.classList.add('visible');

  const qualifies = await scoreQualifies(finalScore);
  if (qualifies) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    nameInput.value = '';
    nameInput.focus();
  } else {
    gameoverMessage.textContent = 'Great run!';
    nameEntry.classList.remove('visible');
    resetTimer = setTimeout(() => { exitGameOver(); }, NON_QUALIFYING_DELAY);
  }
}

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
  gameoverOverlay.classList.add('visible');

  const qualifies = await scoreQualifies(finalScore);
  if (qualifies) {
    gameoverMessage.textContent = 'New high score!';
    nameEntry.classList.add('visible');
    nameInput.value = '';
    nameInput.focus();
  } else {
    gameoverMessage.textContent = '';
    nameEntry.classList.remove('visible');
    resetTimer = setTimeout(() => { exitGameOver(); }, NON_QUALIFYING_DELAY);
  }
}

async function submitScore() {
  let name = nameInput.value.trim();
  if (!name) name = 'Anonymous';
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

// --- Init & game loop ---

async function init() {
  try {
    initRenderer();
    const config = getTrackConfig();
    initPhysics(config);

    render();

    // Pre-fetch leaderboard scores
    fetchScores();

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
    calibrate(performance.now());

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
