# Plan: Fix Static Map After Track Wrap

## Problem

When the ball reaches the end of the track, `physics.js` wraps the ball position back to the start (`ball.z = -halfLength + 1`), but the level (obstacles, coins, turtle) is **never regenerated**. This causes:

1. **Same obstacles every lap** — obstacles stay in identical positions because `regenerateLevel()` is not called on wrap.
2. **No coins visible** — coins collected on the first pass remain hidden (their meshes have `visible = false` and the `coinsCollected` array still marks them as collected).
3. **Turtle missing** — once collected or passed, the turtle doesn't reappear.

## Root Cause

`js/physics.js:142-144` — the track wrap logic only resets `ball.z` but does nothing to refresh the level layout or reset collection state. There is no communication back to `main.js` that a wrap occurred.

## Solution

### Approach: Signal wrap event, regenerate in main.js

The cleanest fix follows the existing pattern (similar to how `coinsCollected` and `turtleCollected` are communicated):

1. **physics.js**: Add a `wrapped: true` flag to the return object of `updateOnTrack()` when the ball wraps around.

2. **physics.js**: Add a new exported function `refreshLevel(config)` that updates obstacles, coins, and turtle references (and resets their collection state) without resetting ball position or velocity.

3. **main.js**: When `result.wrapped` is true, call `regenerateLevel()` to create new obstacle/coin/turtle meshes, then call `refreshLevel()` with the new layout data.

### Detailed Changes

#### js/physics.js

1. Add `wrapped` boolean tracking in `updateOnTrack()`:
   - Set `wrapped = true` when `ball.z > halfLength` triggers the wrap.
   - Include `wrapped` in the return object (default `false`).
   - Also return `wrapped: false` from `updateFalling()`.

2. Add new export `refreshLevel(config)`:
   ```js
   export function refreshLevel(config) {
     obstacles = config.obstacles || [];
     coins = config.coins || [];
     coinsCollected = new Array(coins.length).fill(false);
     turtle = config.turtle || null;
     turtleCollected = false;
   }
   ```
   This updates level data without touching ball state or slowdown timers.

#### js/main.js

1. Import `refreshLevel` from `physics.js`.
2. In the game loop, after `updatePhysics()`, check `result.wrapped`:
   ```js
   if (result.wrapped) {
     regenerateLevel();
     const newConfig = getTrackConfig();
     newConfig.obstacles = getObstacles();
     newConfig.coins = getCoins();
     newConfig.turtle = getTurtle();
     refreshLevel(newConfig);
   }
   ```

### Why not other approaches?

- **Regenerate inside physics.js**: Physics shouldn't know about rendering. The existing architecture separates concerns.
- **Just reset coinsCollected on wrap**: Would show the same layout forever (same obstacle positions). The description says "the map becomes the same" which implies it should differ.
- **Use `initPhysics` on wrap**: Would reset ball position to start, causing a visual teleport and losing slowdown state.

## File Changes Summary

| File | Change |
|------|--------|
| `js/physics.js` | Add `wrapped` flag to return objects; add `refreshLevel()` export |
| `js/main.js` | Import `refreshLevel`; handle `result.wrapped` by regenerating level |

## Verification

- `docker build -t teeter .` must succeed
- After the ball reaches the end of the track and wraps, obstacles should appear in different positions
- Coins should be visible after wrapping (fresh coins in new positions)
- Turtle powerup should reappear after wrapping
- Score should persist across wraps (not reset to 0)
- Existing game-over/restart flow should still work
