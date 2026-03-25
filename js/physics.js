import {
  TRACK_WIDTH,
  TRACK_HEIGHT,
  BALL_RADIUS,
  BALL_START_DISTANCE,
  FINISH_LINE_DISTANCE,
  getPointAtDistance,
  getTangentAtDistance,
  getRightAtDistance,
  trackToWorld,
  getTrackYAtDistance,
  getSlopeAtDistance,
  getTrackLength,
} from './track.js';

const GRAVITY = 9.8;
export const DEFAULT_SENSITIVITY = 15.0;
let directSensitivity = DEFAULT_SENSITIVITY;
const RESPONSE_RATE = 6.0;
const FORWARD_SPEED = 4.5;
const PITCH_SENSITIVITY = 3.0;
const MAX_SPEED = 11.0;
const MOUTH_BOOST_MULTIPLIER = 1.8;
const MAX_DT = 1 / 30;
const COIN_COLLECT_RADIUS = 1.2;
const TURTLE_COLLECT_RADIUS = 1.2;
const SLOWDOWN_DURATION = 4;

let ball = {};
let trackConfig = {};
let obstacles = [];
let coins = [];
let turtles = [];
let collectedCoinIds = new Set();
let collectedTurtleIds = new Set();
let slowdownActive = false;
let slowdownTimer = 0;

export function initPhysics(config) {
  trackConfig = config;
  obstacles = [];
  coins = [];
  turtles = [];
  collectedCoinIds = new Set();
  collectedTurtleIds = new Set();
  slowdownActive = false;
  slowdownTimer = 0;
  resetBall();
}

export function resetBall() {
  const startPos = getPointAtDistance(trackConfig.ballStartDistance);
  ball = {
    distance: trackConfig.ballStartDistance,
    lateral: 0,
    y: startPos.y + trackConfig.trackHeight / 2 + trackConfig.ballRadius,
    vForward: FORWARD_SPEED,
    vLateral: 0,
    vy: 0,
    falling: false,
    worldX: startPos.x,
    worldY: startPos.y + trackConfig.trackHeight / 2 + trackConfig.ballRadius,
    worldZ: startPos.z,
  };
  collectedCoinIds = new Set();
  collectedTurtleIds = new Set();
  slowdownActive = false;
  slowdownTimer = 0;
}

export function updateLevelData(newObstacles, newCoins, newTurtles) {
  obstacles = newObstacles;
  coins = newCoins;
  turtles = newTurtles;
}

export function updatePhysics(dt, tiltAngle, pitch, mouthOpen) {
  dt = Math.min(dt, MAX_DT);
  if (ball.falling) return updateFalling(dt);
  return updateOnTrack(dt, tiltAngle, pitch, mouthOpen);
}

function updateOnTrack(dt, tiltAngle, pitch, mouthOpen) {
  if (slowdownActive) {
    slowdownTimer -= dt;
    if (slowdownTimer <= 0) { slowdownActive = false; slowdownTimer = 0; }
  }

  let effectiveForward = slowdownActive ? FORWARD_SPEED / 2 : FORWARD_SPEED;
  let effectiveMax = slowdownActive ? MAX_SPEED / 2 : MAX_SPEED;

  const boostActive = !!mouthOpen && !ball.falling;
  if (boostActive) {
    effectiveForward *= MOUTH_BOOST_MULTIPLIER;
    effectiveMax *= MOUTH_BOOST_MULTIPLIER;
  }

  // Lateral velocity from head tilt
  const targetVLateral = -tiltAngle * directSensitivity;
  ball.vLateral += (targetVLateral - ball.vLateral) * RESPONSE_RATE * dt;

  // Forward motion modulated by pitch + gravity slope contribution
  const pitchVal = pitch || 0;
  const slope = getSlopeAtDistance(ball.distance);
  const gravityBoost = GRAVITY * slope;
  ball.vForward = Math.max(0.5, Math.min(effectiveMax, effectiveForward * (1 + pitchVal * PITCH_SENSITIVITY) + gravityBoost));

  // Update track-space position
  ball.distance += ball.vForward * dt;
  ball.lateral += ball.vLateral * dt;

  // Clamp distance to track length
  if (ball.distance > getTrackLength()) {
    ball.distance = getTrackLength();
  }

  // Compute world position from track coordinates
  const centerPoint = getPointAtDistance(ball.distance);
  const right = getRightAtDistance(ball.distance);
  ball.worldX = centerPoint.x + right.x * ball.lateral;
  ball.worldY = centerPoint.y + trackConfig.trackHeight / 2 + trackConfig.ballRadius;
  ball.worldZ = centerPoint.z + right.z * ball.lateral;

  // Track boundaries -- ball falls off if lateral exceeds half width
  const halfWidth = trackConfig.trackWidth / 2;
  if (Math.abs(ball.lateral) > halfWidth) {
    ball.falling = true;
    ball.vy = 0;
  }

  // Obstacle collision in track coordinates
  let obstacleHit = false;
  if (!ball.falling) {
    const br = trackConfig.ballRadius;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dd = Math.abs(ball.distance - o.distance);
      const dl = Math.abs(ball.lateral - o.lateral);
      if (dd < o.halfD + br && dl < o.halfW + br) {
        ball.falling = true;
        ball.vy = 0;
        obstacleHit = true;
        break;
      }
    }
  }

  // Coin collection in track coordinates
  const newlyCollected = [];
  for (const coin of coins) {
    if (collectedCoinIds.has(coin.id)) continue;
    const dd = Math.abs(ball.distance - coin.distance);
    const dl = Math.abs(ball.lateral - coin.lateral);
    const dist = Math.sqrt(dd * dd + dl * dl);
    if (dist < COIN_COLLECT_RADIUS) {
      collectedCoinIds.add(coin.id);
      newlyCollected.push(coin.id);
    }
  }

  // Turtle collection in track coordinates
  let turtleJustCollected = null;
  for (const t of turtles) {
    if (collectedTurtleIds.has(t.id)) continue;
    const dd = Math.abs(ball.distance - t.distance);
    const dl = Math.abs(ball.lateral - t.lateral);
    const dist = Math.sqrt(dd * dd + dl * dl);
    if (dist < TURTLE_COLLECT_RADIUS) {
      collectedTurtleIds.add(t.id);
      turtleJustCollected = t.id;
      slowdownActive = true;
      slowdownTimer = SLOWDOWN_DURATION;
      break;
    }
  }

  // Check finish line
  const finished = ball.distance >= trackConfig.finishLineDistance;

  return {
    x: ball.worldX,
    y: ball.worldY,
    z: ball.worldZ,
    distance: ball.distance,
    vx: ball.vLateral,
    vz: ball.vForward,
    falling: ball.falling,
    needsReset: false,
    finished,
    obstacleHit,
    coinsCollected: newlyCollected,
    turtleCollected: turtleJustCollected,
    slowdownActive,
    boostActive,
  };
}

function updateFalling(dt) {
  ball.vy -= GRAVITY * dt;
  ball.worldY += ball.vy * dt;

  // Continue some lateral and forward motion while falling
  const tangent = getTangentAtDistance(ball.distance);
  const right = getRightAtDistance(ball.distance);
  ball.worldX += (tangent.x * ball.vForward * 0.3 + right.x * ball.vLateral * 0.5) * dt;
  ball.worldZ += (tangent.z * ball.vForward * 0.3 + right.z * ball.vLateral * 0.5) * dt;

  const needsReset = ball.worldY < -10;

  return {
    x: ball.worldX,
    y: ball.worldY,
    z: ball.worldZ,
    distance: ball.distance,
    vx: ball.vLateral,
    vz: ball.vForward,
    falling: true,
    needsReset,
    finished: false,
    obstacleHit: false,
    coinsCollected: [],
    turtleCollected: null,
    slowdownActive,
    boostActive: false,
  };
}

export function setSensitivity(value) {
  directSensitivity = value;
}



export function getBallState() {
  return { ...ball };
}
