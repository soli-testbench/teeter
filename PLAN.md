# Plan: Curved Track with Downhill Slope and Finish Line

## Summary

Replace the flat straight BoxGeometry track with a curved, gently downhill course built from a `CatmullRomCurve3` centerline. The ball's physics are rewritten to operate in **curve-local coordinates** (distance-along-curve `t` + lateral offset `d`), which naturally handles turns and slopes. The camera follows the curve tangent. A finish line mesh marks course end and triggers a "finished" game state.

## Codebase Analysis

- **Tech stack**: Pure static HTML+JS (ES modules), Three.js v0.183.2 via CDN importmap, served by nginx in Docker
- **Key files**: `index.html` (HTML/CSS/UI), `js/main.js` (game loop, state), `js/physics.js` (ball physics, collision), `js/renderer.js` (Three.js scene, mesh generation, RNG), `js/tracker.js` (head tracking — DO NOT MODIFY)
- **Current track**: Single `BoxGeometry(4.5, 0.2, 50)` centered at origin, ball moves in +Z direction
- **Current physics**: World-space X/Z coordinates, constant forward speed modulated by pitch, lateral movement from head tilt, wraps at track end
- **Existing features to preserve**: Obstacles (red boxes), coins (gold tori), turtle powerup (green composite mesh), leaderboard, slowdown indicator, score display

## Architecture

### Track Representation

**Centerline curve**: A `CatmullRomCurve3` with ~8–10 control points that create a winding, gently downhill path with 2–3 visible turns. The curve descends about 8–12 units total (roughly 1:10 grade). Control points are hand-placed constants.

Example control points (tunable):
```js
[
  (0, 10, 0),       // Start — elevated
  (0, 9.5, 10),     // Straight entry
  (3, 8.5, 25),     // Gentle right curve
  (5, 7.5, 40),     // Continue right
  (3, 6.5, 55),     // Begin left curve
  (-3, 5.5, 70),    // Left turn
  (-5, 4.5, 85),    // Continue left
  (-2, 3.0, 100),   // Right curve
  (2, 1.5, 115),    // Straighten out
  (2, 0.5, 130),    // Final approach
  (0, 0, 140),      // Finish line
]
```

**Track mesh**: Built procedurally using `BufferGeometry`. Sample the centerline at ~200 evenly-spaced points. At each point, compute the tangent (forward) and lateral (cross product of tangent × world-up, normalized) vectors. Extend the surface ±`TRACK_WIDTH/2` laterally to form a flat ribbon of triangle-strip quads. This produces a road surface that follows curves and slopes naturally.

**Edge lines**: Thin meshes along each edge, built from the same sampling points.

**Finish line**: A striped quad (black/white checkerboard pattern via canvas texture) at curve `t=1.0`, spanning full track width.

### Physics — Curve-Local Coordinates

The ball state is tracked as:
- `t` — normalized position along the centerline curve (0.0 = start, 1.0 = end)
- `d` — lateral offset from centerline (positive = right when facing forward along tangent)
- `speed` — forward speed along the curve (world units/sec)
- `lateralSpeed` — lateral speed (world units/sec)

Each frame:
1. **Gravity slope boost**: Compute `tangent = curve.getTangentAt(t)`. The slope angle determines gravity assist: `gravityBoost = -GRAVITY * tangent.y` (tangent.y is negative when going downhill, so boost is positive). Add `gravityBoost * dt` to forward speed.
2. **Forward motion**: `t += speed * dt / curveLength`. Base speed is `FORWARD_SPEED`, modulated by pitch input and gravity boost. Clamped to `MAX_SPEED`.
3. **Lateral motion**: `d` updated from head tilt input with same sensitivity/smoothing as before.
4. **World position**: Convert `(t, d)` to world: `worldPos = curve.getPointAt(t) + lateral * d + up * (trackHeight/2 + ballRadius)`.
5. **Edge detection**: If `|d| > TRACK_WIDTH/2`, ball falls off.
6. **Obstacle collision**: Obstacles store their own `t` value and lateral offset `d`. Collision checks compare curve-distance and lateral offset.
7. **Finish detection**: When `t >= 1.0`, trigger 'finished' state.

### Camera

Follow the ball along the curve tangent:
```js
const tangent = curve.getTangentAt(ballT);
const cameraPos = ballWorldPos.clone()
  .sub(tangent.clone().multiplyScalar(8))
  .add(new THREE.Vector3(0, 4, 0));
camera.position.lerp(cameraPos, 0.1); // smooth follow
camera.lookAt(ballWorldPos);
```

### Obstacle & Coin Spawning

Generate obstacles and coins in curve-local space:
1. Divide the curve into zones by `t` value (skip safe zone at start)
2. Space obstacles along `t` with minimum spacing (converted from distance)
3. Place coins between obstacles using lateral offset within track bounds
4. Convert all `(t, d)` positions to world coordinates for mesh placement
5. Store `t` values for physics collision checks

The turtle powerup uses the same curve-local placement.

### Finish Line Game State

New state `'finished'` in main.js:
- Triggered when physics returns `finished: true` (ball crosses t >= 1.0)
- Shows an overlay: "COURSE COMPLETE!" with final score
- Uses same leaderboard qualification flow as game over
- Player restarts via same mechanism as exitGameOver

### Run Timer

Add an elapsed time display during gameplay. When finished, show the time alongside score.

## Affected Files

| File | Changes |
|------|---------|
| `js/renderer.js` | Replace BoxGeometry track with curve-based ribbon mesh. Add finish line mesh. Export curve + track data for physics. Rewrite `generateLevel()` for curve-local obstacle/coin placement. Rewrite `updateCamera()` to follow curve tangent. Update shadow camera to follow ball. |
| `js/physics.js` | Rewrite to use curve-local `(t, d)` coordinates. Add gravity slope acceleration. Replace track-end wrap with finish detection. Obstacles and coins checked in curve-local space. |
| `js/main.js` | Add `'finished'` game state. Add run timer tracking. Wire finish-line overlay. Update ball position/camera calls for new API. |
| `index.html` | Add finish overlay HTML/CSS. Add timer display. |

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Track geometry | CatmullRomCurve3 centerline + BufferGeometry ribbon | Smooth curves with simple parameterization; BufferGeometry is most performant for custom mesh |
| Physics model | Curve-local (t, d) coordinates | Cleanly separates forward/lateral movement on any curve shape; edge detection is trivial |
| Curve type | 'centripetal' | Prevents cusps and self-intersections on uneven point spacing |
| Number of turns | 3 (right-left-right) | Meets "at least 2" requirement with variety |
| Total height drop | ~10 units | Noticeable gravity assist without making it a ski slope |
| Finish line visual | Checkerboard canvas texture | Immediately recognizable as a finish line |
| Finish state | Reuses gameover overlay with different title | Minimal new UI, consistent UX |

## Mode: Single

All changes are deeply interconnected. The renderer, physics, and main loop all depend on the same curve data structure and coordinate system. The physics needs the exact curve from the renderer, the main loop needs both physics return values and renderer APIs. A single agent can implement this coherently.

## Sources
- Three.js CatmullRomCurve3: https://threejs.org/docs/#api/en/extras/curves/CatmullRomCurve3
- Three.js BufferGeometry: https://threejs.org/docs/#api/en/core/BufferGeometry
- Three.js ExtrudeGeometry: https://threejs.org/docs/#api/en/geometries/ExtrudeGeometry
