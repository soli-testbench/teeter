# Plan: Add Turtle Slow-Down Powerup

## Overview

Add a collectible turtle-shaped powerup that halves ball speed for 4 seconds when collected. Follows the existing coin spawn/collection pattern across renderer.js, physics.js, main.js, and index.html.

## Codebase Analysis

- **Tech stack**: Pure static HTML+JS (ES modules), Three.js v0.183.2 via CDN importmap, served by nginx in Docker
- **Key files**: `index.html` (HTML/CSS/UI), `js/main.js` (game loop, state), `js/physics.js` (ball physics, collision), `js/renderer.js` (Three.js scene, mesh generation, RNG), `js/tracker.js` (head tracking — DO NOT MODIFY)
- **Coin pattern**: Generated in `renderer.js` via `generateCoins(rng)`, exported via `getCoins()`, collected in `physics.js` via distance check (`COIN_COLLECT_RADIUS = 0.8`), hidden via `hideCoin(idx)` called from `main.js` game loop
- **Speed constants**: `FORWARD_SPEED = 2.0`, `MAX_SPEED = 6.0` in physics.js
- **RNG**: Seeded via `Date.now()` in `generateLevel()`, deterministic `seededRandom()` function

## Technical Approach

### 1. renderer.js — Turtle Mesh & Spawning

**Turtle mesh** (composite Three.js primitives, grouped under `THREE.Group`):
- Body: `SphereGeometry` scaled flat (scaleY ~0.5), dark green `0x228B22`
- Head: smaller `SphereGeometry`, positioned at front of body
- 4 legs: short `CylinderGeometry` positioned at corners
- Shell detail: slightly larger `SphereGeometry` with darker color on top

**Spawn logic** — new `generateTurtle(rng, obstacles)`:
- Pick random Z between `SAFE_ZONE_Z + 5` and `TRACK_LENGTH/2 - 3`, avoiding obstacle Z ranges
- Pick random X within track bounds (±halfTrack - 0.5)
- Spawn exactly 1 turtle per run
- Place at `COIN_Y` height (same as coins)

**Exports to add**:
- `getTurtle()` → returns `{ x, z }` or `null`
- `hideTurtle()` → hides the mesh
- Update `regenerateLevel()` to clean up turtle mesh

### 2. physics.js — Collection & Speed Modifier

**New state variables**:
- `turtle` (position object or null)
- `turtleCollected` (boolean)
- `slowdownActive` (boolean)
- `slowdownTimer` (float, seconds remaining)
- `SLOWDOWN_DURATION = 4` (constant)
- `TURTLE_COLLECT_RADIUS = 0.8`

**In `initPhysics(config)`**: Accept `config.turtle`, reset slowdown state.

**In `updateOnTrack(dt)`**:
- Check turtle proximity (same pattern as coins) → set `turtleCollected`, activate slowdown
- Apply speed modifier: `effectiveForward = slowdownActive ? FORWARD_SPEED / 2 : FORWARD_SPEED`, `effectiveMax = slowdownActive ? MAX_SPEED / 2 : MAX_SPEED`
- Decrement `slowdownTimer` by `dt`; when ≤ 0, deactivate
- Re-collecting while active: reset timer to `SLOWDOWN_DURATION` (no further stacking)
- Return `turtleCollected`, `slowdownActive`, `slowdownTimer` in result object

**In `resetBall()`**: Clear all slowdown state.

### 3. main.js — Wire Collection & UI Indicator

**New imports**: `getTurtle`, `hideTurtle` from renderer.js

**In `init()` and `exitGameOver()`**: Pass turtle data to physics config via `config.turtle = getTurtle()`

**In game loop**:
- Check `result.turtleCollected` → call `hideTurtle()`
- Check `result.slowdownActive` → show/hide `#slowdown-indicator`

**UI indicator element**: Reference `document.getElementById('slowdown-indicator')`

### 4. index.html — Indicator Element & CSS

**CSS** for `#slowdown-indicator`:
- `position: fixed; bottom: 50px; left: 50%; transform: translateX(-50%);`
- Green/teal background, white text, rounded, semi-transparent
- `display: none` by default, `.visible` shows it
- `z-index: 10` (same as score), `pointer-events: none`

**HTML**: `<div id="slowdown-indicator">SLOWED</div>` — placed with other HUD elements

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Turtles per run | 1 | Keeps it rare/special, simpler |
| Slowdown duration | 4 seconds | Middle of 3-5s range from AC |
| Collection radius | 0.8 | Same as existing coins |
| Speed effect | Halve FORWARD_SPEED and MAX_SPEED | Directly from AC |
| Indicator style | Fixed bottom-center text overlay | Visible but not obstructive |
| Turtle color | Green (0x228B22) | Distinct from red obstacles, gold coins |

## Scope: Single Agent

All changes are tightly coupled (mesh → physics → game loop → UI). No meaningful parallelism possible.

## Files Modified

- `js/renderer.js` — turtle mesh, spawn, show/hide, regenerate cleanup
- `js/physics.js` — collection check, speed modifier with timer
- `js/main.js` — wire collection events, UI indicator, pass turtle to physics
- `index.html` — indicator HTML element and CSS styles
