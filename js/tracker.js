const MEDIAPIPE_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

// Landmark indices for eye outer corners
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
// Landmark indices for pitch detection
const NOSE_TIP = 1;
const FOREHEAD = 10;

let faceLandmarker = null;
let videoElement = null;
let rawTilt = 0;
let smoothedTilt = 0;
let rawPitch = 0;
let smoothedPitch = 0;
const SMOOTHING_FACTOR = 0.7;

export async function initTracker(stream) {
  // Create hidden video element — never added to DOM
  videoElement = document.createElement('video');
  videoElement.setAttribute('autoplay', '');
  videoElement.setAttribute('playsinline', '');
  videoElement.srcObject = stream;

  await new Promise((resolve) => {
    videoElement.onloadeddata = resolve;
  });
  await videoElement.play();

  // Load MediaPipe
  const { FaceLandmarker, FilesetResolver } = await import(MEDIAPIPE_VISION_URL);

  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
  });
}

export function detectTilt(timestamp) {
  if (!faceLandmarker || !videoElement || videoElement.readyState < 2) {
    return smoothedTilt;
  }

  const results = faceLandmarker.detectForVideo(videoElement, timestamp);

  if (results.faceLandmarks && results.faceLandmarks.length > 0) {
    const landmarks = results.faceLandmarks[0];
    const leftEye = landmarks[LEFT_EYE_OUTER];
    const rightEye = landmarks[RIGHT_EYE_OUTER];

    // Negate tilt to mirror horizontal mapping (webcam is mirrored)
    rawTilt = -Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
    smoothedTilt = smoothedTilt * SMOOTHING_FACTOR + rawTilt * (1 - SMOOTHING_FACTOR);

    // Compute pitch from the same detection result
    const nose = landmarks[NOSE_TIP];
    const forehead = landmarks[FOREHEAD];
    // Positive pitch = head tilted forward (nose down relative to forehead)
    rawPitch = nose.y - forehead.y;
    smoothedPitch = smoothedPitch * SMOOTHING_FACTOR + rawPitch * (1 - SMOOTHING_FACTOR);
  }

  return smoothedTilt;
}

export function detectPitch() {
  return smoothedPitch;
}

export function resetTilt() {
  rawTilt = 0;
  smoothedTilt = 0;
  rawPitch = 0;
  smoothedPitch = 0;
}
