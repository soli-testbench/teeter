import * as THREE from 'three';

// Track dimensions
export const TRACK_WIDTH = 4.5;
export const TRACK_HEIGHT = 0.2;
export const BALL_RADIUS = 0.3;

// Define waypoints for the curved downhill course
// The course has multiple turns and a steady downhill slope
const WAYPOINTS = [
  new THREE.Vector3(0, 14, 0),
  new THREE.Vector3(0, 13.2, 35),
  new THREE.Vector3(10, 12, 70),
  new THREE.Vector3(20, 10.5, 110),
  new THREE.Vector3(18, 9, 150),
  new THREE.Vector3(5, 7.2, 185),
  new THREE.Vector3(-10, 5.5, 220),
  new THREE.Vector3(-18, 4, 255),
  new THREE.Vector3(-10, 2.5, 285),
  new THREE.Vector3(0, 1.2, 310),
  new THREE.Vector3(0, 0.5, 330),
];

// Create the CatmullRom curve through waypoints
const curve = new THREE.CatmullRomCurve3(WAYPOINTS, false, 'catmullrom', 0.5);

// Cache the total length
const TRACK_LENGTH = curve.getLength();

// Ball start distance (slightly into the track so there's track behind the ball)
export const BALL_START_DISTANCE = 8;

// Finish line distance (near end of track)
export const FINISH_LINE_DISTANCE = TRACK_LENGTH - 12;

// Helper: clamp t to [0, 1]
function clampT(d) {
  return Math.max(0, Math.min(1, d / TRACK_LENGTH));
}

// Get point on curve at arc-length distance d
export function getPointAtDistance(d) {
  return curve.getPointAt(clampT(d));
}

// Get tangent (forward direction) at distance d — normalized
export function getTangentAtDistance(d) {
  return curve.getTangentAt(clampT(d)).normalize();
}

// Right vector perpendicular to tangent, projected into XZ plane
export function getRightAtDistance(d) {
  const tangent = getTangentAtDistance(d);
  // Rotate tangent 90 degrees CW in XZ plane (ignore Y component for lateral)
  const right = new THREE.Vector3(-tangent.z, 0, tangent.x);
  const len = right.length();
  if (len > 0.001) right.divideScalar(len);
  return right;
}

// Convert track coordinates (distance along curve, lateral offset) to world position
// Returns a point on the track surface (top of track)
export function trackToWorld(distance, lateral) {
  const center = getPointAtDistance(distance);
  const right = getRightAtDistance(distance);
  return new THREE.Vector3(
    center.x + right.x * lateral,
    center.y,
    center.z + right.z * lateral
  );
}

// Get track surface Y at a given distance
export function getTrackYAtDistance(d) {
  return getPointAtDistance(d).y;
}

// Get the slope factor for gravity at a distance
// Returns positive when track goes downhill (ball accelerates forward)
export function getSlopeAtDistance(d) {
  const tangent = getTangentAtDistance(d);
  return -tangent.y; // negative tangent.y = going downhill = positive slope
}

// Get total track length
export function getTrackLength() {
  return TRACK_LENGTH;
}

// Get the underlying curve object (for visualization etc.)
export function getCurve() {
  return curve;
}

// Find the nearest distance on the curve to a world point (approximate)
// Used for converting world position back to track coordinates
export function worldToTrackDistance(worldPos) {
  const steps = 200;
  let bestD = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i <= steps; i++) {
    const d = (i / steps) * TRACK_LENGTH;
    const p = getPointAtDistance(d);
    const dx = worldPos.x - p.x;
    const dz = worldPos.z - p.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestD = d;
    }
  }
  return bestD;
}
