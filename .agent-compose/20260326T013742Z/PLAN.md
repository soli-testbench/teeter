# Plan: Fix infinite 'Teeter Loading...' screen hang

## Problem

The `init()` function in `public/js/main.js` can hang indefinitely at the loading screen when:
1. Camera access is denied (already partially handled but lacks retry)
2. MediaPipe face landmark model fails to load (CDN timeout, network error) — no error shown
3. WebGL is unavailable — `THREE.WebGLRenderer()` throws but only caught by a generic handler
4. No timeout mechanism exists — if any async step hangs, the user sees "Loading..." forever

## Current Architecture

- Vanilla JS with ES modules, served via Express (`server.js`)
- Three.js (v0.183.2) via CDN importmap for 3D rendering
- MediaPipe Vision (v0.10.33) via CDN for face tracking
- Files served from `public/` directory
- No build system — direct browser ES modules

## Approach

Single-task fix touching 3 files:

### 1. `public/js/main.js` — Init function hardening

- **WebGL check**: Before calling `initRenderer()`, check `document.createElement('canvas').getContext('webgl2') || ...getContext('webgl')`. If null, show error immediately.
- **MediaPipe error**: Wrap `initTracker(stream)` in its own try/catch with a specific error message about model loading failure.
- **15-second timeout**: Use `Promise.race` with a timeout promise around the entire init sequence (after WebGL check). If the timeout fires, show a "Failed to load" message with retry.
- **Retry button**: Add a "Retry" button to the overlay that calls `location.reload()` (simplest reliable approach since MediaPipe and Three.js don't cleanly support re-init).
- **Race condition guard**: The timeout and success path must cancel each other — if init succeeds, clear the timeout; if timeout fires, set a flag so the success path doesn't proceed.

### 2. `public/index.html` — Add retry button element

- Add a `<button id="retry-btn">` inside the `#overlay` div, hidden by default.

### 3. `public/css/styles.css` — Retry button styling

- Style the retry button to match existing UI (semi-transparent dark bg, white text, rounded).
- Make overlay allow pointer events when in error state (currently `pointer-events: none`).

## Key Decisions

- **Reload for retry** rather than re-running init: MediaPipe loads WASM and GPU resources that don't cleanly teardown. A page reload is the most reliable retry mechanism.
- **15-second timeout** as specified in acceptance criteria.
- **No new dependencies** — pure vanilla JS changes within existing patterns.

## Files to Modify

1. `public/js/main.js` — core init logic changes
2. `public/index.html` — retry button markup
3. `public/css/styles.css` — retry button + error overlay styling
