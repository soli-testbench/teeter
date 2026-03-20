const GRAVITY = 9.8;
const SENSITIVITY = 2.5;
const FRICTION = 3.0;
const FORWARD_SPEED = 2.0;
const PITCH_SENSITIVITY = 3.0;
const MAX_SPEED = 6.0;
const MAX_DT = 1 / 30; // Cap delta time to prevent physics explosions

let ball = {};
let trackConfig = {};

export function initPhysics(config) {
  trackConfig = config;
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
}

export function updatePhysics(dt, tiltAngle, pitch) {
  dt = Math.min(dt, MAX_DT);

  if (ball.falling) {
    return updateFalling(dt);
  }

  return updateOnTrack(dt, tiltAngle, pitch);
}

function updateOnTrack(dt, tiltAngle, pitch) {
  // Lateral acceleration from head tilt
  const ax = GRAVITY * Math.sin(tiltAngle) * SENSITIVITY;
  ball.vx += ax * dt;

  // Rolling friction
  ball.vx *= (1 - FRICTION * dt);

  // Forward motion modulated by pitch (forward tilt speeds up, backward slows down)
  const pitchVal = pitch || 0;
  ball.vz = Math.max(0, Math.min(MAX_SPEED, FORWARD_SPEED * (1 + pitchVal * PITCH_SENSITIVITY)));

  // Update position
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;

  // Track boundaries — check if ball center has gone past track edge
  const halfWidth = trackConfig.trackWidth / 2;
  if (Math.abs(ball.x) > halfWidth) {
    ball.falling = true;
    ball.vy = 0;
  }

  // Track end — wrap back to start if ball reaches the end
  const halfLength = trackConfig.trackLength / 2;
  if (ball.z > halfLength) {
    ball.z = -halfLength + 1;
  }

  return {
    x: ball.x,
    y: ball.y,
    z: ball.z,
    vx: ball.vx,
    vz: ball.vz,
    falling: false,
    needsReset: false,
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
  };
}

export function getBallState() {
  return { ...ball };
}
