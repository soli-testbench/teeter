# Teeter — Implementation Plan

## Overview

Build a browser-based game where the player tilts their head side-to-side to steer a ball along a suspended 3D track. The webcam detects head tilt in real time but is never shown on screen. If the ball falls off, the game auto-restarts.

## Architecture

Single-page application: one `index.html` with embedded JavaScript (no bundler needed). Served via a lightweight static file server in Docker.

### Components

```
┌─────────────────────────────────────────────────┐
│                   Game Loop                      │
│            (requestAnimationFrame)               │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  Head     │→│  Physics  │→│  Renderer     │  │
│  │  Tracker  │  │  Engine   │  │  (Three.js)   │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
│       ↑                                          │
│  [Hidden webcam/video element]                   │
└─────────────────────────────────────────────────┘
```

### 1. Head Tracker (MediaPipe FaceLandmarker)

- **Library**: `@mediapipe/tasks-vision@0.10.33` via CDN
- **Model**: `face_landmarker.task` (float16) loaded from Google Storage CDN
- **Approach**: Use the simple `atan2` method on eye landmarks to compute head roll angle
  - Landmark 33 = left eye outer corner, Landmark 263 = right eye outer corner
  - `roll = atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x)`
  - This gives the head tilt angle in radians, mapped to a lateral force on the ball
- **Running mode**: `VIDEO` with `detectForVideo()` called each frame
- **Why not OpenCV.js solvePnP**: Only need roll angle for head tilt; atan2 is simpler, lighter, and avoids loading an 8MB library
- **Why not facialTransformationMatrixes**: Known accuracy issues when face is off-center (GitHub issue #4759)
- **Video element**: Created programmatically, never added to DOM or rendered

**Sources**:
- [MediaPipe Face Landmarker Web JS Guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [Head Pose Estimation with MediaPipe — Susanne Thierfelder](https://medium.com/@susanne.thierfelder/head-pose-estimation-with-mediapipe-and-opencv-in-javascript-c87980df3acb)
- [Real-Time Face Tracking in the Browser — DEV Community](https://dev.to/kenzic/real-time-face-tracking-in-the-browser-with-mediapipe-22c9)

### 2. Physics Engine (Custom)

Simple physics simulation — no library needed for a ball on a flat track.

- **Ball state**: position (x, z), velocity (vx, vz), on-track flag
- **Track tilt**: Head roll angle maps to track tilt angle (with configurable sensitivity and smoothing)
- **Forces**:
  - Gravity component along tilted track: `ax = g * sin(tiltAngle)`
  - Rolling friction: small damping factor on velocity
  - Forward force: constant gentle forward velocity (z-axis) to move ball along track
- **Edge detection**: If `|ball.x| > trackWidth/2`, ball enters falling state
- **Falling state**: Ball drops with full gravity (negative y velocity), camera watches it fall, then auto-reset after delay
- **Delta time**: Use `performance.now()` delta for frame-rate-independent physics

### 3. Renderer (Three.js)

- **Library**: Three.js `0.183.2` via CDN (importmap)
- **Scene**:
  - Track: `BoxGeometry` — long, narrow, suspended platform with a subtle material (e.g., wood or metallic)
  - Ball: `SphereGeometry` with `MeshStandardMaterial` — positioned on track surface
  - Environment: Gradient sky background, ambient + directional lighting, faint fog for depth
  - Drop below: Empty space beneath the track (fog/darkness conveys height)
- **Camera**: Fixed perspective camera slightly above and behind the ball, looking down the track at an angle
- **Ball rotation**: Rotate the ball mesh based on velocity to show rolling motion
- **Track visual tilt**: Slightly rotate the track mesh around Z-axis to match head tilt (visual feedback)

### 4. Game Loop

```
each frame:
  1. Read head tilt from tracker (if face detected)
  2. Smooth the tilt value (exponential moving average)
  3. Apply physics: update ball velocity and position
  4. Check edge condition → trigger fall if off-track
  5. Update Three.js scene (ball position, rotation, track tilt)
  6. Render
```

### 5. Camera Permission Handling

- On load, show a centered message: "Teeter — Tilt your head to steer"
- Call `navigator.mediaDevices.getUserMedia({ video: true })`
- If denied: Show clear error message "Camera access is required to play. Please allow camera access and reload."
- If granted: Initialize MediaPipe, start game loop

### 6. Serving & Dockerfile

- **Server**: Use `python3 -m http.server 8080` or `nginx` in Docker
- **Dockerfile**: Alpine + nginx, copies static files, exposes port 8080
- CI expects `Dockerfile` at repo root; deploy pushes to Fly.io

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Rendering | Three.js via CDN | Industry standard for browser 3D; no build step needed |
| Head tracking | MediaPipe FaceLandmarker | Google-maintained, runs entirely in browser, good perf |
| Tilt computation | atan2 on eye landmarks | Simplest approach; only need roll for side-to-side tilt |
| Physics | Custom | Ball-on-track is too simple to warrant a physics library |
| Bundler | None (importmap) | Single page, few dependencies; keeps build trivial |
| Serving | nginx in Docker | Matches CI/deploy expectations; lightweight |

## File Structure

```
/
├── index.html          # Main game page (HTML + inline CSS)
├── js/
│   ├── main.js         # Entry point, game loop, camera setup
│   ├── tracker.js      # MediaPipe head tilt tracking
│   ├── physics.js      # Ball physics simulation
│   └── renderer.js     # Three.js scene setup and rendering
├── Dockerfile          # nginx-based static file serving
├── nginx.conf          # nginx configuration
├── PLAN.md
├── CLAUDE.md
└── README.md
```

## Execution Mode

**Single agent** — The game loop, physics, rendering, and head tracking are tightly coupled. Each frame reads from the tracker, updates physics, and renders. Splitting across agents would create integration complexity with no parallel speedup benefit.

## Risks & Mitigations

- **MediaPipe model loading time**: Model is ~4MB; show loading indicator during init
- **Webcam latency**: Use exponential smoothing on tilt values to reduce jitter without adding perceptible lag
- **Performance**: MediaPipe FaceLandmarker runs at 30+ FPS on modern hardware; Three.js scene is minimal
- **Browser compatibility**: Target Chrome desktop only (per AC #8); use standard Web APIs
