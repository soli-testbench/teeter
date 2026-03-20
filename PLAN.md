# Plan: Control Fixes

## Problem Analysis

### Issue 1: Lateral tilt is inverted
**Root cause**: The webcam produces a mirrored (selfie) image. When the user tilts their head physically to the right, the webcam shows the right eye going *down* relative to the left eye. The `atan2` in `tracker.js:53` computes a positive tilt angle for this case. This positive tilt feeds into `physics.js:39` as `GRAVITY * Math.sin(tiltAngle) * SENSITIVITY`, producing positive lateral acceleration (moving the ball to the right in world space). However, because the webcam is mirrored, a physical rightward tilt appears as a leftward tilt in the video — the math is correct for the mirrored image but wrong for the user's physical perspective.

**Fix**: Negate the raw tilt value in `tracker.js` by flipping the sign: `rawTilt = -Math.atan2(...)`. This mirrors the horizontal mapping so physical right tilt → ball moves right.

### Issue 2: Camera perspective and forward motion direction
**Root cause**: The ball starts at `z = -20` and moves in the `+z` direction (`vz = FORWARD_SPEED = 2.0`). The camera is positioned at `z = ballZ + 8` (i.e., at `z = -12` when ball is at `z = -20`), looking toward the ball. Since the ball moves toward `+z` and the camera is at `+z` relative to ball, the ball moves *toward* the camera — i.e., toward the player.

**Fix**: Reposition the camera *behind* the ball in the `-z` direction. Change camera offset from `+8` to `-8` on z-axis:
- `camera.position.z = ballZ - 8` (camera is behind ball)
- `camera.lookAt(0, 0, ballZ)` (still looks at ball)

This means the ball moves away from the camera (away from the player) in the `+z` direction. The initial camera position in `initRenderer` also needs to change from `BALL_START_Z + 8` to `BALL_START_Z - 8`.

### Issue 2b: Forward tilt controls speed
**Root cause**: Currently, only lateral tilt (roll) is detected. There's no pitch detection.

**Fix**: Add pitch detection to `tracker.js` using face landmarks. Use the nose tip (landmark 1) and forehead (landmark 10) to compute pitch angle. Tilting forward (head down, nose closer to camera) should increase speed; tilting backward (head up) should decrease speed.

Export a `detectPitch` function from `tracker.js`. In `physics.js`, make `vz` responsive to pitch:
- Base speed: `FORWARD_SPEED = 2.0`
- Pitch modulates speed: `vz = FORWARD_SPEED * (1 + pitch * PITCH_SENSITIVITY)`
- Clamp to `[0, maxSpeed]` so the ball doesn't go backward or too fast

Wire pitch through `main.js` into `updatePhysics`.

## Files to Change

1. **`js/tracker.js`** — Negate tilt sign, add pitch detection and smoothing
2. **`js/physics.js`** — Accept pitch parameter, modulate forward speed based on pitch
3. **`js/renderer.js`** — Flip camera to behind the ball (change `+8` to `-8`)
4. **`js/main.js`** — Wire pitch from tracker to physics

## Scope Assessment

This is a **single** agent task. All changes are tightly coupled (tracker feeds physics feeds renderer), and the total diff is small (< 40 lines changed across 4 files).
