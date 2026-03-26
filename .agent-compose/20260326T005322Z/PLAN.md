# Plan: Fix Infinite "Teeter Loading..." Screen Hang

## Problem Analysis

The game's `init()` function in `js/main.js` has multiple initialization steps that can silently fail or hang indefinitely, leaving users stuck on "Teeter Loading..." forever:

1. **WebGL Renderer creation** (`initRenderer()` at main.js:217) — `new THREE.WebGLRenderer()` throws if WebGL is unavailable. Currently caught by a generic catch that says "Failed to initialize" without specifics.

2. **Camera access** (`getUserMedia()` at main.js:234) — Already has a specific catch, but the error message is static and doesn't help users on browsers that silently dismiss permission prompts.

3. **MediaPipe tracker initialization** (`initTracker()` at main.js:245, tracker.js:20-44) — This is the most fragile step with 4 sub-operations that can each fail/hang:
   - Video element `onloadeddata` event — could never fire
   - Dynamic `import()` of MediaPipe vision bundle from CDN — network failure hangs forever
   - `FilesetResolver.forVisionTasks()` — WASM loading can fail silently
   - `FaceLandmarker.createFromOptions()` — model download (7MB+) or GPU delegate can fail

4. **No global timeout** — Nothing prevents infinite waiting on any step.

## Solution Design

### Approach: Wrap init steps with error detection + global timeout + retry UI

All changes are confined to two files:
- `index.html` — Add retry button markup and minimal styling
- `js/main.js` — Refactor `init()` with step-specific error handling and a 15-second timeout

### Key Changes

#### 1. WebGL Detection (pre-check)
Before calling `initRenderer()`, check `document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')`. If null, show a specific "WebGL not supported" error immediately. This avoids the Three.js exception path.

#### 2. Camera Error Specificity
The existing catch for `getUserMedia` is adequate but will be enhanced to distinguish between `NotAllowedError` (user denied), `NotFoundError` (no camera), and other errors.

#### 3. MediaPipe Loading — Wrap with Promise.race Timeout
Wrap `initTracker(stream)` in a `Promise.race` against a per-step timeout. If it fails, show "Head tracking model failed to load" with details.

#### 4. Global 15-Second Timeout
Wrap the entire `init()` body in a `Promise.race` against a 15-second timer. If the timer wins, abort initialization and show a "Failed to load" message with a retry button.

#### 5. Retry Button
Add a "Retry" button to the overlay in `index.html`. When clicked, it reloads the page (`location.reload()`). This is the simplest reliable retry mechanism since partially-initialized state (video elements, WebGL contexts, MediaPipe models) is difficult to cleanly tear down.

#### 6. Error Display Enhancement
Modify `showError()` in main.js to show the retry button and update the overlay styling. The existing `.error` CSS class already sets red text.

### Files Changed

| File | Change |
|------|--------|
| `index.html` | Add retry button inside `#overlay`, add CSS for retry button |
| `js/main.js` | Refactor `init()` with WebGL pre-check, step-specific errors, 15s timeout, retry button wiring |

### What We Do NOT Change

- `js/tracker.js` — Per CLAUDE.md from prior plan: "DO NOT MODIFY". We wrap its exported `initTracker()` with timeout logic from main.js instead.
- `js/renderer.js` — No changes needed; `initRenderer()` already throws on WebGL failure.
- `js/physics.js` — Not related to loading.
- `Dockerfile` / `nginx.conf` — No changes needed.

### Architecture Decisions

1. **Page reload for retry** vs. re-calling `init()`: Reload is safer because partial WebGL contexts and MediaPipe WASM instances are hard to clean up. A full reload guarantees a clean slate.

2. **15-second timeout location**: Applied as a race around the entire `init()` function rather than per-step. This is simpler and matches the acceptance criteria ("15 seconds triggers a failed-to-load message"). Individual steps get descriptive status updates so users see progress.

3. **No new dependencies**: All changes use vanilla JS — `Promise.race`, `AbortController` for cleanup, standard DOM APIs. Matches the existing no-build-step architecture.
