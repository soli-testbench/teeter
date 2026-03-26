# Plan: Show Ball Speed Indicator

## Status

This feature is **already fully implemented** in the codebase (commit `59ec0e7`). All acceptance criteria are met. This plan documents the existing implementation and tasks a single agent with verifying correctness and making any minor adjustments if needed.

## Existing Implementation

### HTML (`index.html:283-298, 323`)
- `#speed` div positioned `bottom: 16px; left: 16px` — lower-left corner
- Styled consistently with `#score` and `#level` HUD elements: same font family (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`), white color, `font-weight: 700`, semi-transparent black background (`rgba(0,0,0,0.3)`), `border-radius: 8px`, `text-shadow`
- `display: none` by default — hidden until gameplay starts

### JavaScript (`main.js:39, 188, 223, 292, 344-345`)
- `speedEl` reference grabbed at module load
- Speed computed each frame in game loop: `Math.sqrt(vx² + vz²)` from physics result
- Displayed as `speed.toFixed(1) + ' m/s'`
- Shown (`display: block`) when game starts and after game over reset
- Hidden (`display: none`) during game over

### Acceptance Criteria Mapping
1. **Lower-left corner** — `bottom: 16px; left: 16px` ✓
2. **Real-time each frame** — calculated in `gameLoop()` every frame ✓
3. **Readable format** — `.toFixed(1)` + `' m/s'` ✓
4. **Hidden on start/game-over** — `display: none` default, hidden in `enterGameOver()`, shown in `exitGameOver()` and `init()` ✓
5. **Consistent visual style** — matches `#score` and `#level` exactly ✓

## Tech Stack
- Vanilla HTML/CSS/JS with ES modules
- Three.js (v0.183.2) for 3D rendering via CDN import map
- No build system, no package.json — static files served by nginx
- No test framework present

## Task Decomposition
Single task — verify the existing implementation satisfies all criteria. No new code expected.

## Sources
- Direct codebase inspection (no external research needed — feature is trivial DOM manipulation)
