# Plan: Blink-to-Jump Mechanic

## Status

The blink-to-jump feature is **already fully implemented** on this branch (commit `5f07653`). All 8 acceptance criteria are satisfied by the existing code. This plan documents the implementation for validation and any needed polish.

## Tech Stack

- Vanilla JavaScript (ES modules, no build step)
- Three.js r0.183.2 (CDN import map)
- MediaPipe Tasks Vision v0.10.33 (CDN)
- Static hosting via nginx + Docker

No new dependencies are required. The implementation reuses MediaPipe's face landmark model that is already loaded for tilt/pitch/mouth detection.

## Architecture

### Blink Detection (`js/tracker.js`)

The Eye Aspect Ratio (EAR) approach is used — the standard method for blink detection with facial landmarks:

- **Landmarks**: Uses 6 points per eye (MediaPipe indices):
  - Right eye: `[33, 159, 158, 133, 153, 145]`
  - Left eye: `[362, 386, 385, 263, 374, 380]`
- **EAR formula**: `(dist(p2,p6) + dist(p3,p5)) / (2 * dist(p1,p4))` — ratio of vertical to horizontal eye dimensions
- **Edge detection**: Triggers only on the transition from open→closed (`lastEAR >= threshold && current < threshold`)
- **Threshold**: `EAR_THRESHOLD = 0.21` — below this the eye is considered closed
- **Cooldown**: `BLINK_COOLDOWN = 500ms` — prevents double-triggers from single blinks
- **Data reuse**: `currentLandmarks` is set by `detectTilt()` each frame, so `detectBlink()` reuses the same landmarks without a second MediaPipe call

### Jump Physics (`js/physics.js`)

- **Impulse**: `JUMP_IMPULSE = 6.5` — upward velocity applied on blink
- **Gravity**: `JUMP_GRAVITY = 12.0` — separate from fall gravity (9.8) for tighter arc control
- **Max height**: ~1.76 units (`v²/2g = 6.5²/(2*12)`), clearing obstacles at 1.0 height
- **Landing**: Ball returns to `groundY = trackHeight/2 + ballRadius`, `jumping` flag cleared
- **State**: `ball.jumping` boolean tracks airborne status

### Collision Skipping

- Obstacle AABB check gated by `!ball.falling && !ball.jumping` (line 130)
- Coin collection gated by `!ball.jumping` (line 150)
- Turtle collection gated by `!ball.jumping` (line 165)
- Track edge check **not** gated — ball can still fall off edges during jump
- Lateral steering (vx update) runs unconditionally during jumps

### Integration (`js/main.js`)

- `detectBlink()` called each frame alongside `detectTilt()`, `detectPitch()`, `detectMouthOpen()`
- Result passed as `blink` parameter to `updatePhysics(dt, tiltAngle, pitch, mouthOpen, blink)`
- Blink state reset in `resetTilt()` (clears `lastEAR`, `lastBlinkTime`)

## Acceptance Criteria Mapping

| # | Criterion | Implementation | Status |
|---|-----------|---------------|--------|
| 1 | `detectBlink()` exported from tracker.js using eyelid landmarks normalized by inter-eye distance | `tracker.js:162-180` — EAR with 3D landmark distances | Done |
| 2 | Thresholds and cooldown (≥500ms) | `EAR_THRESHOLD=0.21`, `BLINK_COOLDOWN=500`, edge-triggered | Done |
| 3 | Ball receives upward impulse on blink when on track | `physics.js:104-107` — `ball.vy = JUMP_IMPULSE` when `!jumping && !falling` | Done |
| 4 | Gravity arc, lands back on track surface | `physics.js:110-119` — `JUMP_GRAVITY` applied, lands at `groundY` | Done |
| 5 | Obstacle collisions skipped while airborne | `physics.js:130` — `!ball.jumping` guard on obstacle check | Done |
| 6 | Jump height clears walls/turtles | Max height ~1.76 > obstacle height 1.0 | Done |
| 7 | Can fall off track edges during jump | `physics.js:122-126` — edge check unconditional | Done |
| 8 | Lateral steering works during jump | `physics.js:92-100` — vx/x update before jump check | Done |

## Sources

- MediaPipe Face Landmarker landmarks: standard 478-point mesh, indices per https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
- Eye Aspect Ratio (EAR) for blink detection: Soukupová & Čech, "Real-Time Eye Blink Detection using Facial Landmarks" (2016)
