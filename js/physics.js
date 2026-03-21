const GRAVITY = 9.8;
const DIRECT_SENSITIVITY = 15.0;
const RESPONSE_RATE = 6.0;
const FORWARD_SPEED = 2.0;
const PITCH_SENSITIVITY = 3.0;
const MAX_SPEED = 6.0;
const MAX_DT = 1 / 30;
const COIN_COLLECT_RADIUS = 0.6; // In lateral-distance space
const COIN_COLLECT_T_RADIUS = 0.005; // In t-space
const TURTLE_COLLECT_RADIUS = 0.6;
const TURTLE_COLLECT_T_RADIUS = 0.005;
const SLOWDOWN_DURATION = 4;
const OBSTACLE_COLLISION_T_RADIUS = 0.004;

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
    t: 0, // Position along curve (0-1)
    d: 0, // Lateral offset from centerline
    speed: FORWARD_SPEED, // Forward speed in world units/sec
    lateralSpeed: 0, // Lateral speed
    falling: false,
    vy: 0, // Vertical velocity when falling
    worldX: 0,
    worldY: 0,
    worldZ: 0,
  };

  // Compute initial world position
  if (trackConfig.curveLocalToWorld) {
    const pos = trackConfig.curveLocalToWorld(0, 0, trackConfig.ballRadius);
    ball.worldX = pos.x;
    ball.worldY = pos.y;
    ball.worldZ = pos.z;
  }

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
  const { curve, curveLength, curveLocalToWorld, trackWidth, trackHeight, ballRadius } = trackConfig;
  if (!curve) return getFallbackResult();

  // Decrement slowdown timer
  if (slowdownActive) {
    slowdownTimer -= dt;
    if (slowdownTimer <= 0) {
      slowdownActive = false;
      slowdownTimer = 0;
    }
  }

  const effectiveForward = slowdownActive ? FORWARD_SPEED / 2 : FORWARD_SPEED;
  const effectiveMax = slowdownActive ? MAX_SPEED / 2 : MAX_SPEED;

  // Direct lateral velocity from head tilt with smooth interpolation
  const targetVx = -tiltAngle * DIRECT_SENSITIVITY;
  ball.vx += (targetVx - ball.vx) * RESPONSE_RATE * dt;

  // Get tangent at current position for slope calculation
  const clampedT = Math.max(0, Math.min(1, ball.t));
  const tangent = curve.getTangentAt(clampedT);

  // Gravity slope boost — tangent.y < 0 means going downhill
  const gravityBoost = -GRAVITY * tangent.y * 0.3;

  // Forward motion: base speed + gravity + pitch modulation
  const pitchVal = pitch || 0;
  const baseSpeed = effectiveForward * (1 + pitchVal * PITCH_SENSITIVITY);
  ball.speed = Math.max(0.5, Math.min(effectiveMax, baseSpeed + gravityBoost));

  // Lateral movement from head tilt
  const targetLateral = tiltAngle * DIRECT_SENSITIVITY;
  ball.lateralSpeed += (targetLateral - ball.lateralSpeed) * RESPONSE_RATE * dt;

  // Update curve-local position
  ball.t += (ball.speed * dt) / curveLength;
  ball.d += ball.lateralSpeed * dt;

  // Edge detection — fall off if past track edge
  const halfWidth = trackWidth / 2;
  if (Math.abs(ball.d) > halfWidth) {
    ball.falling = true;
    ball.vy = 0;
  }

  // Obstacle collision in curve-local space
  let obstacleHit = false;
  if (!ball.falling) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const tDist = Math.abs(ball.t - o.t);
      const dDist = Math.abs(ball.d - o.d);

      if (tDist < OBSTACLE_COLLISION_T_RADIUS && dDist < o.halfW + ballRadius * 0.5) {
        ball.falling = true;
        ball.vy = 0;
        obstacleHit = true;
        break;
      }
    }
  }

  // Coin collection in curve-local space
  const newlyCollected = [];
  for (let i = 0; i < coins.length; i++) {
    if (coinsCollected[i]) continue;
    const tDist = Math.abs(ball.t - coins[i].t);
    const dDist = Math.abs(ball.d - coins[i].d);
    if (tDist < COIN_COLLECT_T_RADIUS && dDist < COIN_COLLECT_RADIUS) {
      coinsCollected[i] = true;
      newlyCollected.push(i);
    }
  }

  // Turtle collection
  let turtleJustCollected = false;
  if (turtle && !turtleCollected) {
    const tDist = Math.abs(ball.t - turtle.t);
    const dDist = Math.abs(ball.d - turtle.d);
    if (tDist < TURTLE_COLLECT_T_RADIUS && dDist < TURTLE_COLLECT_RADIUS) {
      turtleCollected = true;
      turtleJustCollected = true;
      slowdownActive = true;
      slowdownTimer = SLOWDOWN_DURATION;
    }
  }

  // Finish line — ball crossed the end of the track
  let finished = false;
  if (ball.t >= 1.0) {
    ball.t = 1.0;
    ball.speed = 0;
    ball.lateralSpeed = 0;
    finished = true;
  }

  // Convert curve-local to world position
  const safeT = Math.max(0, Math.min(0.9999, ball.t));
  const worldPos = curveLocalToWorld(safeT, ball.d, ballRadius);
  ball.worldX = worldPos.x;
  ball.worldY = worldPos.y;
  ball.worldZ = worldPos.z;

  return {
    x: ball.worldX,
    y: ball.worldY,
    z: ball.worldZ,
    vx: ball.lateralSpeed,
    vz: ball.speed,
    t: ball.t,
    d: ball.d,
    falling: ball.falling,
    needsReset: false,
    obstacleHit,
    finished,
    coinsCollected: newlyCollected,
    turtleCollected: turtleJustCollected,
    slowdownActive,
  };
}

function updateFalling(dt) {
  ball.vy -= GRAVITY * dt;
  ball.worldY += ball.vy * dt;

  // Continue lateral and forward drift
  ball.worldX += ball.lateralSpeed * dt * 0.5;
  ball.worldZ += ball.speed * dt * 0.3;

  const needsReset = ball.worldY < -10;

  return {
    x: ball.worldX,
    y: ball.worldY,
    z: ball.worldZ,
    vx: ball.lateralSpeed,
    vz: ball.speed,
    t: ball.t,
    d: ball.d,
    falling: true,
    needsReset,
    obstacleHit: false,
    finished: false,
    coinsCollected: [],
    turtleCollected: false,
    slowdownActive,
  };
}

export function refreshLevel(config) {
  obstacles = config.obstacles || [];
  coins = config.coins || [];
  coinsCollected = new Array(coins.length).fill(false);
  turtle = config.turtle || null;
  turtleCollected = false;
}

function getFallbackResult() {
  return {
    x: 0, y: 0, z: 0,
    vx: 0, vz: 0,
    t: 0, d: 0,
    falling: false, needsReset: false,
    obstacleHit: false, finished: false, coinsCollected: [], turtleCollected: false,
    slowdownActive: false,
  };
}

export function getBallState() {
  return { ...ball };
}
