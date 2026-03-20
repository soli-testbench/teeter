const GRAVITY = 9.8;
const DIRECT_SENSITIVITY = 8.0;
const RESPONSE_RATE = 6.0;
const FORWARD_SPEED = 2.0;
const PITCH_SENSITIVITY = 3.0;
const MAX_SPEED = 6.0;
const MAX_DT = 1 / 30; // Cap delta time to prevent physics explosions
const COIN_COLLECT_RADIUS = 0.8;
const TURTLE_COLLECT_RADIUS = 0.8;
const SLOWDOWN_DURATION = 4;

let ball = {};
let trackConfig = {};
let obstacles = [];
let coins = [];
let coinsCollected = [];
let turtle = null;
let turtleCollected = false;
let slowdownActive = false;
let slowdownTimer = 0;

export function initPhysics(config) {
  trackConfig = config;
  obstacles = config.obstacles || [];
  coins = config.coins || [];
  coinsCollected = new Array(coins.length).fill(false);
  turtle = config.turtle || null;
  turtleCollected = false;
  slowdownActive = false;
  slowdownTimer = 0;
  resetBall();
}

export function resetBall() {
  ball = {
    x: 0,
    y: trackConfig.trackHeight / 2 + trackConfig.ballRadius,
    z: trackConfig.ballStartZ,
    vx: 0,
    vy: 0,
    vz: FORWARD_SPEED,
    falling: false,
  };
  coinsCollected = new Array(coins.length).fill(false);
  turtleCollected = false;
  slowdownActive = false;
  slowdownTimer = 0;
}

export function updatePhysics(dt, tiltAngle, pitch) {
  dt = Math.min(dt, MAX_DT);

  if (ball.falling) {
    return updateFalling(dt);
  }

  return updateOnTrack(dt, tiltAngle, pitch);
}

function updateOnTrack(dt, tiltAngle, pitch) {
  // Decrement slowdown timer
  if (slowdownActive) {
    slowdownTimer -= dt;
    if (slowdownTimer <= 0) {
      slowdownActive = false;
      slowdownTimer = 0;
    }
  }

  // Effective speeds (halved when slowed)
  const effectiveForward = slowdownActive ? FORWARD_SPEED / 2 : FORWARD_SPEED;
  const effectiveMax = slowdownActive ? MAX_SPEED / 2 : MAX_SPEED;

  // Direct lateral velocity from head tilt with smooth interpolation
  const targetVx = tiltAngle * DIRECT_SENSITIVITY;
  ball.vx += (targetVx - ball.vx) * RESPONSE_RATE * dt;

  // Forward motion modulated by pitch (forward tilt speeds up, backward slows down)
  const pitchVal = pitch || 0;
  ball.vz = Math.max(0, Math.min(effectiveMax, effectiveForward * (1 + pitchVal * PITCH_SENSITIVITY)));

  // Update position
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;

  // Track boundaries — check if ball center has gone past track edge
  const halfWidth = trackConfig.trackWidth / 2;
  if (Math.abs(ball.x) > halfWidth) {
    ball.falling = true;
    ball.vy = 0;
  }

  // Obstacle collision — AABB check with ball radius margin
  let obstacleHit = false;
  if (!ball.falling) {
    const br = trackConfig.ballRadius;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (
        ball.x + br > o.x - o.halfW &&
        ball.x - br < o.x + o.halfW &&
        ball.z + br > o.z - o.halfD &&
        ball.z - br < o.z + o.halfD
      ) {
        ball.falling = true;
        ball.vy = 0;
        obstacleHit = true;
        break;
      }
    }
  }

  // Coin collection — distance check in XZ plane
  const newlyCollected = [];
  for (let i = 0; i < coins.length; i++) {
    if (coinsCollected[i]) continue;
    const dx = ball.x - coins[i].x;
    const dz = ball.z - coins[i].z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < COIN_COLLECT_RADIUS) {
      coinsCollected[i] = true;
      newlyCollected.push(i);
    }
  }

  // Turtle collection — distance check in XZ plane
  let turtleJustCollected = false;
  if (turtle && !turtleCollected) {
    const dx = ball.x - turtle.x;
    const dz = ball.z - turtle.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < TURTLE_COLLECT_RADIUS) {
      turtleCollected = true;
      turtleJustCollected = true;
      slowdownActive = true;
      slowdownTimer = SLOWDOWN_DURATION;
    }
  }

  // Track end — wrap back to start if ball reaches the end
  let trackCompleted = false;
  const halfLength = trackConfig.trackLength / 2;
  if (ball.z > halfLength) {
    ball.z = -halfLength + 1;
    trackCompleted = true;
  }

  return {
    x: ball.x,
    y: ball.y,
    z: ball.z,
    vx: ball.vx,
    vz: ball.vz,
    falling: ball.falling,
    needsReset: false,
    obstacleHit,
    coinsCollected: newlyCollected,
    turtleCollected: turtleJustCollected,
    slowdownActive,
    trackCompleted,
  };
}

function updateFalling(dt) {
  ball.vy -= GRAVITY * dt;
  ball.y += ball.vy * dt;

  // Also continue lateral and forward motion slightly
  ball.x += ball.vx * dt * 0.5;
  ball.z += ball.vz * dt * 0.3;

  const needsReset = ball.y < -10;

  return {
    x: ball.x,
    y: ball.y,
    z: ball.z,
    vx: ball.vx,
    vz: ball.vz,
    falling: true,
    needsReset,
    obstacleHit: false,
    coinsCollected: [],
    turtleCollected: false,
    slowdownActive,
    trackCompleted: false,
  };
}

export function refreshLevel(config) {
  obstacles = config.obstacles || [];
  coins = config.coins || [];
  coinsCollected = new Array(coins.length).fill(false);
  turtle = config.turtle || null;
  turtleCollected = false;
}

export function getBallState() {
  return { ...ball };
}
