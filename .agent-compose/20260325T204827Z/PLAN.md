# Plan: Head Tilt Sensitivity Controls

## Overview

Add a user-configurable sensitivity slider to the Teeter head-tilt ball game. The slider controls `DIRECT_SENSITIVITY` (currently hardcoded at 8.0 in `physics.js`), persists via `localStorage`, and takes effect immediately during gameplay.

## Codebase Context

- **Stack**: Pure static HTML + vanilla ES modules JS. No build step, no npm. Served by nginx via Docker.
- **Files involved**: `index.html` (UI + CSS), `js/physics.js` (sensitivity constant + physics), `js/main.js` (game loop + state management)
- **DO NOT MODIFY**: `js/tracker.js` (MediaPipe head tracking), `js/renderer.js` (no changes needed)
- **Existing patterns**:
  - Constants at top of `physics.js` as `const`
  - localStorage used in `main.js` for leaderboard (`STORAGE_KEY = 'teeter_highscores'`)
  - UI overlays use CSS classes `.visible`/`.hidden` for show/hide toggling
  - Semi-transparent dark panels (`rgba(0,0,0,0.x)`) with rounded corners for UI
  - Font: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
  - 2-space indentation throughout

## Technical Approach

### 1. Physics sensitivity as a settable value (`js/physics.js`)

Convert `DIRECT_SENSITIVITY` from a `const` to a `let` with default value 8.0 (Note: despite the task description mentioning 15.0, the actual current value in the codebase is 8.0). Add exported getter/setter:

```js
const DEFAULT_SENSITIVITY = 8.0;
let directSensitivity = DEFAULT_SENSITIVITY;

export function setSensitivity(value) {
  directSensitivity = value;
}

export function getSensitivity() {
  return directSensitivity;
}
```

Update the one usage on line 75 (`tiltAngle * DIRECT_SENSITIVITY`) to use the mutable variable.

### 2. Sensitivity slider UI (`index.html`)

Add a settings gear button (fixed position, top-right area near the leaderboard button) and a settings panel overlay. The panel contains:

- A range slider (`<input type="range">`) with min=5, max=30, step=0.5
- A numeric label showing current value
- A "Reset to Default" button

Design matches existing game UI: dark semi-transparent backdrop, rounded panel, white text, same font stack.

### 3. Wiring and persistence (`js/main.js`)

- On init, read sensitivity from `localStorage` key `teeter_sensitivity`, parse as float, clamp to [5, 30], and call `setSensitivity()`
- On slider `input` event, call `setSensitivity()` and write to `localStorage`
- Reset button sets slider to default (8.0), calls `setSensitivity()`, and updates `localStorage`
- Settings panel toggle: gear button opens/closes panel. Click outside panel closes it.
- Game continues to run while settings panel is open (sensitivity changes are instant)

### 4. Slider range and labels

- Range: 5.0 (Low) to 30.0 (High), default 8.0
- Display format: numeric value (e.g., "8.0") alongside descriptive labels:
  - 5.0–10.0: "Low"
  - 10.5–18.0: "Medium"
  - 18.5–30.0: "High"

## Files Changed

| File | Change |
|---|---|
| `js/physics.js` | Convert `DIRECT_SENSITIVITY` to mutable, add `setSensitivity`/`getSensitivity` exports |
| `js/main.js` | Import setter/getter, add localStorage persistence, wire slider events |
| `index.html` | Add settings button, settings panel HTML, slider CSS |

## Key Decisions

1. **Single task** — all changes are tightly coupled (UI + wiring + physics) and touch only 3 files. No benefit to parallelism.
2. **Gear icon as text** — use Unicode gear (⚙) rather than adding an SVG/icon library, matching the lightweight no-dependency approach.
3. **Panel stays open during gameplay** — sensitivity changes apply instantly; no need to pause the game.
4. **Range 5–30** — matches the acceptance criteria suggestion. The default is 8.0 (the actual codebase value), not 15.0 (which the task description referenced from an older version).
5. **No new dependencies** — pure DOM manipulation matching existing patterns.
