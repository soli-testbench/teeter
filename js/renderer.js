import * as THREE from 'three';
import {
  TRACK_WIDTH,
  TRACK_HEIGHT,
  BALL_RADIUS,
  BALL_START_DISTANCE,
  getPointAtDistance,
  getTangentAtDistance,
  getRightAtDistance,
  trackToWorld,
  getTrackLength,
  initTrack,
  ensureTrackTo,
} from './track.js';

const SEGMENT_LENGTH = 1.5;
const OBSTACLE_WIDTH = 1.5;
const OBSTACLE_HEIGHT = 1.0;
const OBSTACLE_DEPTH = 0.4;
const OBSTACLE_MIN_SPACING = 7;
const OBSTACLE_MAX_SPACING = 9;
const SAFE_ZONE_DISTANCE = 15;
const COIN_RADIUS = 0.25;
const COIN_TUBE = 0.08;
const TURTLE_SPAWN_CHANCE = 0.25;
const TURTLE_SEGMENT_LENGTH = 60;

// Moving wall constants
const MOVING_WALL_WIDTH = 1.2;
const MOVING_WALL_HEIGHT = 1.2;
const MOVING_WALL_DEPTH = 0.4;
const MOVING_WALL_START_DISTANCE = 40;
const MOVING_WALL_MIN_SPACING = 15;
const MOVING_WALL_MAX_SPACING = 25;

// Chunk system constants
const CHUNK_SIZE = 30;
const CHUNKS_AHEAD = 4;
const CHUNKS_BEHIND = 2;

let scene, camera, renderer, dirLight;
let ballMesh;

// Shared geometries and materials
const segGeo = new THREE.BoxGeometry(TRACK_WIDTH, TRACK_HEIGHT, SEGMENT_LENGTH * 1.05);
const edgeGeo = new THREE.BoxGeometry(0.06, 0.12, SEGMENT_LENGTH * 1.05);
const obstGeo = new THREE.BoxGeometry(OBSTACLE_WIDTH, OBSTACLE_HEIGHT, OBSTACLE_DEPTH);
const obstMat = new THREE.MeshStandardMaterial({ color: 0x8B2222, roughness: 0.5, metalness: 0.2 });
const movingWallGeo = new THREE.BoxGeometry(MOVING_WALL_WIDTH, MOVING_WALL_HEIGHT, MOVING_WALL_DEPTH);
const movingWallMat = new THREE.MeshStandardMaterial({ color: 0xCC44FF, roughness: 0.3, metalness: 0.5, emissive: 0x6622AA, emissiveIntensity: 0.4 });
const coinGeo = new THREE.TorusGeometry(COIN_RADIUS, COIN_TUBE, 12, 24);
const coinMat = new THREE.MeshStandardMaterial({ color: 0xFFD700, metalness: 0.8, roughness: 0.2, emissive: 0x554400, emissiveIntensity: 0.3 });
const trackMat = new THREE.MeshStandardMaterial({ color: 0x8B7355, roughness: 0.7, metalness: 0.1 });
const edgeMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.6 });

function seededRandom(seed) {
  let s = Math.abs(Math.floor(seed)) || 1;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

let globalSeed = Date.now();

// Chunk storage: Map<chunkIndex, chunkData>
let chunks = new Map();

function createChunkData() {
  return {
    trackMeshes: [],
    edgeMeshes: [],
    obstacleMeshes: [],
    obstacleData: [],
    coinEntries: [],
    turtleEntries: [],
    movingWallEntries: [],
  };
}

function buildChunkTrackMesh(chunk, startD, endD) {
  const numSegments = Math.ceil((endD - startD) / SEGMENT_LENGTH);
  for (let i = 0; i < numSegments; i++) {
    const d = startD + (i + 0.5) * SEGMENT_LENGTH;
    if (d > endD) break;
    const pos = getPointAtDistance(d);
    const tangent = getTangentAtDistance(d);
    const tMesh = new THREE.Mesh(segGeo, trackMat);
    tMesh.position.copy(pos);
    const forward = new THREE.Vector3(0, 0, 1);
    tMesh.quaternion.setFromUnitVectors(forward, tangent);
    tMesh.receiveShadow = true;
    scene.add(tMesh);
    chunk.trackMeshes.push(tMesh);
    const right = getRightAtDistance(d);
    const halfW = TRACK_WIDTH / 2;
    const eLeft = new THREE.Mesh(edgeGeo, edgeMat);
    eLeft.position.set(pos.x - right.x * halfW, pos.y + TRACK_HEIGHT / 2 + 0.06, pos.z - right.z * halfW);
    eLeft.quaternion.copy(tMesh.quaternion);
    scene.add(eLeft);
    chunk.edgeMeshes.push(eLeft);
    const eRight = new THREE.Mesh(edgeGeo, edgeMat);
    eRight.position.set(pos.x + right.x * halfW, pos.y + TRACK_HEIGHT / 2 + 0.06, pos.z + right.z * halfW);
    eRight.quaternion.copy(tMesh.quaternion);
    scene.add(eRight);
    chunk.edgeMeshes.push(eRight);
  }
}

function generateChunkObstacles(chunkIndex, startD, endD) {
  const rng = seededRandom(globalSeed + chunkIndex * 1000);
  const obstacles = [];
  const halfTrack = TRACK_WIDTH / 2;
  let d = startD;
  if (d < SAFE_ZONE_DISTANCE) d = SAFE_ZONE_DISTANCE;
  while (d < endD) {
    const spacing = OBSTACLE_MIN_SPACING + rng() * (OBSTACLE_MAX_SPACING - OBSTACLE_MIN_SPACING);
    d += spacing;
    if (d >= endD) break;
    const maxOffset = halfTrack - OBSTACLE_WIDTH / 2 - 0.1;
    const lateral = (rng() * 2 - 1) * maxOffset;
    obstacles.push({ distance: d, lateral, halfW: OBSTACLE_WIDTH / 2, halfD: OBSTACLE_DEPTH / 2 });
  }
  return obstacles;
}

function generateChunkCoins(chunkIndex, obstacles, startD, endD) {
  const rng = seededRandom(globalSeed + chunkIndex * 1000 + 9973);
  const coins = [];
  const halfTrack = TRACK_WIDTH / 2;
  const safeStart = Math.max(startD, SAFE_ZONE_DISTANCE + 1);
  for (let i = 0; i < obstacles.length; i++) {
    const sD = i === 0 ? safeStart : obstacles[i - 1].distance + 1;
    const eD = obstacles[i].distance - 1;
    const gap = eD - sD;
    if (gap < 2) continue;
    const count = gap >= 5 ? 3 : 2;
    const step = gap / (count + 1);
    for (let j = 1; j <= count; j++) {
      coins.push({ distance: sD + step * j, lateral: (rng() * 2 - 1) * (halfTrack - 0.5) });
    }
  }
  const lastD = obstacles.length > 0 ? obstacles[obstacles.length - 1].distance + 1 : safeStart;
  const gap = endD - lastD;
  if (gap >= 3) {
    const count = Math.min(3, Math.max(2, Math.floor(gap / 4)));
    const step = gap / (count + 1);
    for (let j = 1; j <= count; j++) {
      coins.push({ distance: lastD + step * j, lateral: (rng() * 2 - 1) * (halfTrack - 0.5) });
    }
  }
  return coins;
}

function generateChunkTurtles(chunkIndex, obstacles, startD, endD) {
  const rng = seededRandom(globalSeed + chunkIndex * 1000 + 4201);
  const turtles = [];
  const halfTrack = TRACK_WIDTH / 2;
  const safeStart = Math.max(startD, SAFE_ZONE_DISTANCE + 10);
  if (safeStart >= endD) return turtles;
  for (let segStart = safeStart; segStart < endD; segStart += TURTLE_SEGMENT_LENGTH) {
    if (rng() >= TURTLE_SPAWN_CHANCE) continue;
    const segEnd = Math.min(segStart + TURTLE_SEGMENT_LENGTH, endD);
    let attempts = 0;
    while (attempts < 20) {
      const d = segStart + rng() * (segEnd - segStart);
      let clear = true;
      for (const o of obstacles) {
        if (Math.abs(d - o.distance) < 2) { clear = false; break; }
      }
      if (clear) {
        turtles.push({ distance: d, lateral: (rng() * 2 - 1) * (halfTrack - 0.5) });
        break;
      }
      attempts++;
    }
  }
  return turtles;
}

function generateChunkMovingWalls(chunkIndex, staticObstacles, startD, endD) {
  const rng = seededRandom(globalSeed + chunkIndex * 1000 + 7777);
  const walls = [];
  let d = Math.max(startD, MOVING_WALL_START_DISTANCE);
  if (d >= endD) return walls;
  while (d < endD) {
    const spacing = MOVING_WALL_MIN_SPACING + rng() * (MOVING_WALL_MAX_SPACING - MOVING_WALL_MIN_SPACING);
    d += spacing;
    if (d >= endD) break;
    let tooClose = false;
    for (const o of staticObstacles) {
      if (Math.abs(d - o.distance) < 3) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const phase = rng() * Math.PI * 2;
    const speed = 1.2 + rng() * 0.8;
    const range = (TRACK_WIDTH / 2) - (MOVING_WALL_WIDTH / 2) - 0.3;
    walls.push({
      distance: d,
      halfW: MOVING_WALL_WIDTH / 2,
      halfD: MOVING_WALL_DEPTH / 2,
      speed, range, phase,
      currentLateral: 0,
    });
  }
  return walls;
}

function createTurtleMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x228B22, roughness: 0.6, metalness: 0.1 });
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x185818, roughness: 0.5, metalness: 0.15 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x2EA52E, roughness: 0.5, metalness: 0.1 });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), shellMat);
  shell.scale.set(1, 0.5, 1.1);
  shell.position.y = 0.1;
  group.add(shell);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), bodyMat);
  body.scale.set(1, 0.35, 1.05);
  body.position.y = -0.02;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), headMat);
  head.position.set(0, 0.05, 0.42);
  group.add(head);
  const legGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 6);
  for (const p of [{ x: -0.22, z: 0.2 }, { x: 0.22, z: 0.2 }, { x: -0.22, z: -0.2 }, { x: 0.22, z: -0.2 }]) {
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.set(p.x, -0.1, p.z);
    group.add(leg);
  }
  return group;
}

function placeChunkObstacles(chunk, obstacleData, chunkIndex) {
  for (let i = 0; i < obstacleData.length; i++) {
    const o = obstacleData[i];
    const worldPos = trackToWorld(o.distance, o.lateral);
    const tangent = getTangentAtDistance(o.distance);
    const mesh = new THREE.Mesh(obstGeo, obstMat);
    mesh.position.set(worldPos.x, worldPos.y + TRACK_HEIGHT / 2 + OBSTACLE_HEIGHT / 2, worldPos.z);
    mesh.rotation.y = Math.atan2(tangent.x, tangent.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    chunk.obstacleMeshes.push(mesh);
    chunk.obstacleData.push(o);
  }
}

function placeChunkCoins(chunk, coinData, chunkIndex) {
  for (let i = 0; i < coinData.length; i++) {
    const c = coinData[i];
    const worldPos = trackToWorld(c.distance, c.lateral);
    const mesh = new THREE.Mesh(coinGeo, coinMat);
    mesh.position.set(worldPos.x, worldPos.y + TRACK_HEIGHT / 2 + 0.35, worldPos.z);
    mesh.rotation.x = Math.PI / 2;
    scene.add(mesh);
    chunk.coinEntries.push({ mesh, data: { distance: c.distance, lateral: c.lateral, id: 'c_' + chunkIndex + '_' + i } });
  }
}

function placeChunkTurtles(chunk, turtleData, chunkIndex) {
  for (let i = 0; i < turtleData.length; i++) {
    const t = turtleData[i];
    const worldPos = trackToWorld(t.distance, t.lateral);
    const mesh = createTurtleMesh();
    mesh.position.set(worldPos.x, worldPos.y + TRACK_HEIGHT / 2 + 0.35, worldPos.z);
    scene.add(mesh);
    chunk.turtleEntries.push({ mesh, data: { distance: t.distance, lateral: t.lateral, id: 't_' + chunkIndex + '_' + i } });
  }
}

function placeChunkMovingWalls(chunk, wallData, chunkIndex) {
  for (let i = 0; i < wallData.length; i++) {
    const w = wallData[i];
    const worldPos = trackToWorld(w.distance, 0);
    const tangent = getTangentAtDistance(w.distance);
    const mesh = new THREE.Mesh(movingWallGeo, movingWallMat);
    mesh.position.set(worldPos.x, worldPos.y + TRACK_HEIGHT / 2 + MOVING_WALL_HEIGHT / 2, worldPos.z);
    mesh.rotation.y = Math.atan2(tangent.x, tangent.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    chunk.movingWallEntries.push({ mesh, data: { ...w, id: 'mw_' + chunkIndex + '_' + i } });
  }
}

function buildChunk(chunkIndex) {
  if (chunks.has(chunkIndex)) return;
  const startD = chunkIndex * CHUNK_SIZE;
  const endD = startD + CHUNK_SIZE;
  ensureTrackTo(endD + 10);
  const chunk = createChunkData();
  buildChunkTrackMesh(chunk, startD, endD);
  const obstacleData = generateChunkObstacles(chunkIndex, startD, endD);
  placeChunkObstacles(chunk, obstacleData, chunkIndex);
  const coinData = generateChunkCoins(chunkIndex, obstacleData, startD, endD);
  placeChunkCoins(chunk, coinData, chunkIndex);
  const turtleData = generateChunkTurtles(chunkIndex, obstacleData, startD, endD);
  placeChunkTurtles(chunk, turtleData, chunkIndex);
  const movingWallData = generateChunkMovingWalls(chunkIndex, obstacleData, startD, endD);
  placeChunkMovingWalls(chunk, movingWallData, chunkIndex);
  chunks.set(chunkIndex, chunk);
}

function destroyChunk(chunkIndex) {
  const chunk = chunks.get(chunkIndex);
  if (!chunk) return;
  for (const m of chunk.trackMeshes) scene.remove(m);
  for (const m of chunk.edgeMeshes) scene.remove(m);
  for (const m of chunk.obstacleMeshes) scene.remove(m);
  for (const e of chunk.coinEntries) scene.remove(e.mesh);
  for (const e of chunk.turtleEntries) {
    e.mesh.traverse((child) => { if (child.isMesh) { child.geometry.dispose(); child.material.dispose(); } });
    scene.remove(e.mesh);
  }
  for (const e of chunk.movingWallEntries) scene.remove(e.mesh);
  chunks.delete(chunkIndex);
}

export function updateChunks(ballDistance) {
  const ballChunk = Math.floor(ballDistance / CHUNK_SIZE);
  const minChunk = Math.max(0, ballChunk - CHUNKS_BEHIND);
  const maxChunk = ballChunk + CHUNKS_AHEAD;
  for (let i = minChunk; i <= maxChunk; i++) {
    buildChunk(i);
  }
  for (const [idx] of chunks) {
    if (idx < minChunk || idx > maxChunk) {
      destroyChunk(idx);
    }
  }
}

function clearAllChunks() {
  for (const [idx] of chunks) {
    destroyChunk(idx);
  }
  chunks = new Map();
}

export function initRenderer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 40, 120);

  globalSeed = Date.now();
  initTrack(globalSeed);

  const startPos = getPointAtDistance(BALL_START_DISTANCE);
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(startPos.x, startPos.y + 4, startPos.z - 8);
  camera.lookAt(startPos);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0x404060, 0.8);
  scene.add(ambient);

  dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(startPos.x + 5, startPos.y + 10, startPos.z + 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 80;
  dirLight.shadow.camera.left = -15;
  dirLight.shadow.camera.right = 15;
  dirLight.shadow.camera.top = 40;
  dirLight.shadow.camera.bottom = -40;
  scene.add(dirLight);
  scene.add(dirLight.target);

  const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 32, 32);
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xff4444, metalness: 0.3, roughness: 0.4 });
  ballMesh = new THREE.Mesh(ballGeo, ballMat);
  ballMesh.castShadow = true;
  ballMesh.position.copy(startPos);
  ballMesh.position.y += TRACK_HEIGHT / 2 + BALL_RADIUS;
  scene.add(ballMesh);

  updateChunks(BALL_START_DISTANCE);
  window.addEventListener('resize', onResize);
  return { scene, camera, renderer };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

export function updateBallPosition(x, y, z) { ballMesh.position.set(x, y, z); }
export function resetBallRotation() { ballMesh.rotation.set(0, 0, 0); }
export function updateBallRotation(vx, vz, dt) {
  ballMesh.rotation.x -= (vz / BALL_RADIUS) * dt;
  ballMesh.rotation.z += (vx / BALL_RADIUS) * dt;
}

let smoothCamPos = new THREE.Vector3();
let smoothCamTarget = new THREE.Vector3();
let cameraInitialized = false;

export function updateCamera(ballDistance, ballWorldX, ballWorldY, ballWorldZ) {
  const tangent = getTangentAtDistance(ballDistance);
  const targetCamPos = new THREE.Vector3(ballWorldX - tangent.x * 10, ballWorldY + 5, ballWorldZ - tangent.z * 10);
  const targetLookAt = new THREE.Vector3(ballWorldX + tangent.x * 5, ballWorldY, ballWorldZ + tangent.z * 5);
  if (!cameraInitialized) {
    smoothCamPos.copy(targetCamPos);
    smoothCamTarget.copy(targetLookAt);
    cameraInitialized = true;
  } else {
    smoothCamPos.lerp(targetCamPos, 0.04);
    smoothCamTarget.lerp(targetLookAt, 0.04);
  }
  camera.position.copy(smoothCamPos);
  camera.lookAt(smoothCamTarget);
  dirLight.position.set(ballWorldX + 5, ballWorldY + 10, ballWorldZ + 5);
  dirLight.target.position.set(ballWorldX, ballWorldY, ballWorldZ);
}

export function render() { renderer.render(scene, camera); }

export function getTrackConfig() {
  return {
    trackWidth: TRACK_WIDTH, trackHeight: TRACK_HEIGHT, ballRadius: BALL_RADIUS,
    ballStartDistance: BALL_START_DISTANCE,
  };
}

export function resetTrack() {
  clearAllChunks();
  globalSeed = Date.now();
  initTrack(globalSeed);
  updateChunks(BALL_START_DISTANCE);
  cameraInitialized = false;
}

export function getActiveObstacles() {
  const result = [];
  for (const [, chunk] of chunks) {
    for (const o of chunk.obstacleData) {
      result.push({ distance: o.distance, lateral: o.lateral, halfW: o.halfW, halfD: o.halfD, height: OBSTACLE_HEIGHT });
    }
    for (const entry of chunk.movingWallEntries) {
      const w = entry.data;
      result.push({
        distance: w.distance,
        lateral: w.currentLateral,
        halfW: w.halfW,
        halfD: w.halfD,
        height: MOVING_WALL_HEIGHT,
      });
    }
  }
  return result;
}

export function getActiveCoins() {
  const result = [];
  for (const [, chunk] of chunks) {
    for (const entry of chunk.coinEntries) { if (entry.mesh.visible) result.push(entry.data); }
  }
  return result;
}

export function getActiveTurtles() {
  const result = [];
  for (const [, chunk] of chunks) {
    for (const entry of chunk.turtleEntries) { if (entry.mesh.visible) result.push(entry.data); }
  }
  return result;
}

export function hideCoinById(coinId) {
  for (const [, chunk] of chunks) {
    for (const entry of chunk.coinEntries) { if (entry.data.id === coinId) { entry.mesh.visible = false; return; } }
  }
}

export function hideTurtleById(turtleId) {
  for (const [, chunk] of chunks) {
    for (const entry of chunk.turtleEntries) { if (entry.data.id === turtleId) { entry.mesh.visible = false; return; } }
  }
}

export function updateSceneColors(hexColor) {
  const color = new THREE.Color(hexColor);
  scene.background = color;
  scene.fog.color = color;
}

export function updateCoinRotation(dt) {
  for (const [, chunk] of chunks) {
    for (const entry of chunk.coinEntries) { if (entry.mesh.visible) entry.mesh.rotation.y += 2.0 * dt; }
    for (const entry of chunk.turtleEntries) { if (entry.mesh.visible) entry.mesh.rotation.y += 1.5 * dt; }
  }
}

export function updateMovingWalls(timestamp) {
  const time = timestamp / 1000;
  for (const [, chunk] of chunks) {
    for (const entry of chunk.movingWallEntries) {
      const w = entry.data;
      const lateral = Math.sin(time * w.speed + w.phase) * w.range;
      w.currentLateral = lateral;
      const worldPos = trackToWorld(w.distance, lateral);
      entry.mesh.position.set(
        worldPos.x,
        worldPos.y + TRACK_HEIGHT / 2 + MOVING_WALL_HEIGHT / 2,
        worldPos.z
      );
    }
  }
}
