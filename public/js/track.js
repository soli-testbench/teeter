import * as THREE from 'three';

// Track dimensions
export const TRACK_WIDTH = 4.5;
export const TRACK_HEIGHT = 0.2;
export const BALL_RADIUS = 0.3;

// Ball start distance (slightly into the track so there's track behind the ball)
export const BALL_START_DISTANCE = 8;

// Waypoint generation parameters
const WAYPOINT_Z_MIN = 30;
const WAYPOINT_Z_MAX = 40;
const WAYPOINT_X_WANDER = 15;
const WAYPOINT_X_CLAMP = 25;
const WAYPOINT_Y_DROP_MIN = 1.0;
const WAYPOINT_Y_DROP_MAX = 2.5;
const EXTEND_BUFFER = 150;

// Seeded RNG for deterministic generation
function seededRandom(seed) {
  let s = Math.abs(Math.floor(seed)) || 1;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Dynamic track state
let waypoints = [];
let curve = null;
let trackLength = 0;
let trackSeed = 1;
let waypointRng = null;

// Initialize the track with a seed
export function initTrack(seed) {
  trackSeed = seed || Date.now();
  waypointRng = seededRandom(trackSeed);

  // Start with initial waypoints for a good opening section
  waypoints = [
    new THREE.Vector3(0, 14, 0),
    new THREE.Vector3(0, 13.2, 35),
    new THREE.Vector3(10, 12, 70),
    new THREE.Vector3(20, 10.5, 110),
  ];

  // Generate enough track for initial play
  extendTrackWaypoints(10);
  rebuildCurve();
}

function extendTrackWaypoints(count) {
  for (let i = 0; i < count; i++) {
    const prev = waypoints[waypoints.length - 1];
    const prevPrev = waypoints[waypoints.length - 2];

    const z = prev.z + WAYPOINT_Z_MIN + waypointRng() * (WAYPOINT_Z_MAX - WAYPOINT_Z_MIN);

    // X wanders with some momentum from previous direction
    const prevDx = prev.x - prevPrev.x;
    const newDx = prevDx * 0.3 + (waypointRng() * 2 - 1) * WAYPOINT_X_WANDER;
    const x = Math.max(-WAYPOINT_X_CLAMP, Math.min(WAYPOINT_X_CLAMP, prev.x + newDx));

    // Y gently descends
    const yDrop = WAYPOINT_Y_DROP_MIN + waypointRng() * (WAYPOINT_Y_DROP_MAX - WAYPOINT_Y_DROP_MIN);
    const y = prev.y - yDrop;

    waypoints.push(new THREE.Vector3(x, y, z));
  }
}

function rebuildCurve() {
  curve = new THREE.CatmullRomCurve3(waypoints, false, 'catmullrom', 0.5);
  // Scale arc-length divisions with track length for accuracy
  const lastZ = waypoints[waypoints.length - 1].z;
  curve.arcLengthDivisions = Math.max(200, Math.ceil(lastZ / 1.5));
  trackLength = curve.getLength();
}

// Ensure the track extends at least to minDistance + buffer
export function ensureTrackTo(minDistance) {
  if (trackLength >= minDistance + EXTEND_BUFFER) return;

  let attempts = 0;
  while (trackLength < minDistance + EXTEND_BUFFER && attempts < 50) {
    extendTrackWaypoints(5);
    rebuildCurve();
    attempts++;
  }
}

// Helper: clamp t to [0, 1]
function clampT(d) {
  return Math.max(0, Math.min(1, d / trackLength));
}

// Get point on curve at arc-length distance d
export function getPointAtDistance(d) {
  ensureTrackTo(d);
  return curve.getPointAt(clampT(d));
}

// Get tangent (forward direction) at distance d — normalized
export function getTangentAtDistance(d) {
  ensureTrackTo(d);
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
  return trackLength;
}

// Get the underlying curve object (for visualization etc.)
export function getCurve() {
  return curve;
}

// Get the seed for the current track
export function getTrackSeed() {
  return trackSeed;
}
