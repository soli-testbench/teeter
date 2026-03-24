# Plan: Blink-to-Jump Mechanic

## Overview

Add blink detection to the face tracking system (`tracker.js`) and use it to trigger a ball jump in `physics.js`. When the player blinks, the ball launches upward with enough height to clear obstacles (walls and turtles), adding a new gameplay dimension alongside head-tilt steering and mouth-open boost.

## Codebase Context

- **Stack**: Pure static HTML+JS served by nginx. No npm, no build step. Three.js v0.183.2 via CDN importmap. MediaPipe FaceLandmarker v0.10.33 via CDN.
- **Key files**:
  - `js/tracker.js` — MediaPipe face landmark detection (tilt, pitch). **No mouth-open detection exists yet** despite the task description referencing it; the existing pattern is `detectTilt()` and `detectPitch()`.
  - `js/physics.js` — Ball physics, collision, coin/turtle collection, track wrapping.
  - `js/main.js` — Game loop wiring detection to physics to rendering.
  - `js/renderer.js` — Three.js scene, meshes, level generation.
  - `index.html` — HTML + CSS + importmap.

## Technical Approach

### 1. Blink Detection (`tracker.js`)

**Eye Aspect Ratio (EAR)** is the standard approach for blink detection with MediaPipe FaceLandmarker.

**Landmark indices** (from MediaPipe Face Mesh 478-point model):

| Position | Right Eye | Left Eye | Role |
|----------|-----------|----------|------|
| P1 (outer corner) | 33 | 362 | Horizontal reference |
| P2 (upper lid) | 159 | 386 | Vertical |
| P3 (upper lid 2) | 158 | 385 | Vertical |
| P4 (inner corner) | 133 | 263 | Horizontal reference |
| P5 (lower lid) | 153 | 374 | Vertical |
| P6 (lower lid 2) | 145 | 380 | Vertical |

**EAR Formula**:
```
EAR = (||P2 - P6|| + ||P3 - P5||) / (2.0 * ||P1 - P4||)
```

When EAR drops below a threshold (~0.21), the eye is considered closed. We average both eyes' EAR to get a robust signal. The inter-eye distance normalization happens implicitly since EAR is a ratio of the eye's own vertical-to-horizontal dimensions.

**Blink detection logic**:
- Compute average EAR each frame from the same `faceLandmarker.detectForVideo()` results already obtained in `detectTilt()`.
- A blink is detected when EAR drops below threshold AND was previously above it (transition-based, not level-based).
- **Cooldown**: 500ms minimum between blink triggers to prevent rapid re-jumps.
- Export `detectBlink()` that returns `true` on the frame a blink is first detected (after cooldown).

**Key design choice**: Rather than calling `detectForVideo()` a second time in `detectBlink()`, we store the landmarks computed in `detectTilt()` and reuse them. This means `detectTilt()` must be called first each frame (which is already the case in `main.js`).

### 2. Jump Physics (`physics.js`)

**New state**:
- `ball.jumping` — boolean, true while airborne from a jump
- `ball.groundY` — the track surface Y for the ball center (computed from `trackHeight/2 + ballRadius`)

**Jump constants**:
- `JUMP_IMPULSE = 5.0` — initial upward velocity (tuned so peak height clears OBSTACLE_HEIGHT=1.0 with margin)
- `JUMP_GRAVITY = 12.0` — gravity during jump (separate from fall gravity for better game feel)

**Physics**:
- On blink trigger (when `!ball.falling && !ball.jumping`): set `ball.vy = JUMP_IMPULSE`, `ball.jumping = true`
- Each frame while jumping: `ball.vy -= JUMP_GRAVITY * dt`, `ball.y += ball.vy * dt`
- Landing: when `ball.y <= ball.groundY`, set `ball.y = ball.groundY`, `ball.vy = 0`, `ball.jumping = false`

**Peak height calculation**: With impulse=5.0 and gravity=12.0, peak = v^2/(2g) = 25/24 ≈ 1.04 units above ground. OBSTACLE_HEIGHT is 1.0, and the obstacle sits on the track surface (its bottom at trackHeight/2 = 0.1). So the ball center needs to clear 1.1 + ballRadius(0.3) = 1.4 above ground. Let's use JUMP_IMPULSE = 6.5 and JUMP_GRAVITY = 12.0: peak = 42.25/24 ≈ 1.76 — comfortably clears obstacles.

**Collision skip**: While `ball.jumping`, skip obstacle collision checks and turtle/coin collection. The ball arc allows it to fly over walls and turtles.

**Edge behavior**: Track boundary checks (falling off edges) still apply during jumps — lateral movement continues.

**Lateral steering**: `updateOnTrack()` already computes lateral velocity from tilt. During a jump, this continues working. The jump only adds vertical motion.

### 3. Game Loop Integration (`main.js`)

- Import `detectBlink` from `tracker.js`.
- In the game loop, after getting `tiltAngle` and `pitch`, call `detectBlink()`.
- Pass `blink` boolean to `updatePhysics(dt, tiltAngle, pitch, blink)`.
- `updatePhysics` routes to a new `updateJumping(dt, tiltAngle)` when `ball.jumping` is true, or initiates a jump in `updateOnTrack` when `blink` is true.

### 4. Return Object Changes

Add `jumping: ball.jumping` to the return objects of `updateOnTrack`, `updateJumping`, and `updateFalling` so the game loop can track state.

## Architecture Decision: Single Task

This is a single, cohesive feature that touches three tightly-coupled files (tracker → main → physics). The changes are interdependent: `detectBlink()` feeds into `updatePhysics()` which feeds into the game loop. Splitting this into parallel tasks would create integration overhead without benefit. **1 task**.

## Risk Mitigation

- **False blink triggers**: The EAR threshold + cooldown + transition detection (must go below AND come back up) makes accidental triggers unlikely.
- **Tuning**: Jump impulse/gravity values are calculated analytically but may need empirical tuning. The acceptance criteria say "sufficient to clear wall obstacles" — our calculated peak of ~1.76 units above ground comfortably clears the 1.0-unit-tall obstacles.
- **Existing behavior**: The `falling` state (game over) is orthogonal to jumping. A jumping ball can still fall off edges. No changes to the falling/gameover flow.

## Sources

- [MediaPipe Eye Blink Detection with EAR (GitHub)](https://github.com/Pushtogithub23/Eye-Blink-Detection-using-MediaPipe-and-OpenCV)
- [MediaPipe Face Landmarker Documentation](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [EAR Formula and landmark indices (ResearchGate)](https://www.researchgate.net/figure/MediaPipe-Facemesh-Left-Eye-Landmarks-for-calculating-Eye-Aspect-Ratio-EAR_fig1_368318088)

## File Changes Summary

| File | Change |
|------|--------|
| `js/tracker.js` | Add EAR computation, `detectBlink()` export with cooldown |
| `js/physics.js` | Add jump state, `JUMP_IMPULSE`/`JUMP_GRAVITY` constants, jump initiation in `updateOnTrack`, new `updateJumping()` function, skip collisions while airborne |
| `js/main.js` | Import `detectBlink`, call it in game loop, pass blink to `updatePhysics` |
