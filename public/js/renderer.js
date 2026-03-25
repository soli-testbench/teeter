import * as THREE from 'three';
import {
  TRACK_WIDTH,
  TRACK_HEIGHT,
  BALL_RADIUS,
  BALL_START_DISTANCE,
  FINISH_LINE_DISTANCE,
  getPointAtDistance,
  getTangentAtDistance,
  getRightAtDistance,
  trackToWorld,
  getTrackLength,
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

let scene, camera, renderer, dirLight;
let ballMesh;

let trackMeshes = [];
let edgeMeshes = [];
let obstacleMeshes = [];
let coinEntries = [];
let turtleEntries = [];
let movingWallEntries = [];
let finishLineMeshes = [];

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

function buildTrackMesh() {
  const trackLength = getTrackLength();
  const numSegments = Math.ceil(trackLength / SEGMENT_LENGTH);
  const segGeo = new THREE.BoxGeometry(TRACK_WIDTH, TRACK_HEIGHT, SEGMENT_LENGTH * 1.05);
  const edgeGeo = new THREE.BoxGeometry(0.06, 0.12, SEGMENT_LENGTH * 1.05);

  for (let i = 0; i < numSegments; i++) {
    const d = (i + 0.5) * SEGMENT_LENGTH;
    if (d > trackLength) break;

    const pos = getPointAtDistance(d);
    const tangent = getTangentAtDistance(d);

    const tMesh = new THREE.Mesh(segGeo, trackMat);
    tMesh.position.copy(pos);
    const forward = new THREE.Vector3(0, 0, 1);
    tMesh.quaternion.setFromUnitVectors(forward, tangent);
    tMesh.receiveShadow = true;
    scene.add(tMesh);
    trackMeshes.push(tMesh);

    const right = getRightAtDistance(d);
    const halfW = TRACK_WIDTH / 2;

    const eLeft = new THREE.Mesh(edgeGeo, edgeMat);
    eLeft.position.set(pos.x - right.x * halfW, pos.y + TRACK_HEIGHT / 2 + 0.06, pos.z - right.z * halfW);
    eLeft.quaternion.copy(tMesh.quaternion);
    scene.add(eLeft);
    edgeMeshes.push(eLeft);

    const eRight = new THREE.Mesh(edgeGeo, edgeMat);
    eRight.position.set(pos.x + right.x * halfW, pos.y + TRACK_HEIGHT / 2 + 0.06, pos.z + right.z * halfW);
    eRight.quaternion.copy(tMesh.quaternion);
    scene.add(eRight);
    edgeMeshes.push(eRight);
  }
}

function buildFinishLine() {
  const d = FINISH_LINE_DISTANCE;
  const pos = getPointAtDistance(d);
  const tangent = getTangentAtDistance(d);
  const right = getRightAtDistance(d);
  const halfW = TRACK_WIDTH / 2;
  const trackY = pos.y + TRACK_HEIGHT / 2;

  const bannerWidth = TRACK_WIDTH + 0.5;
  const bannerHeight = 2.0;
  const bannerGeo = new THREE.PlaneGeometry(bannerWidth, bannerHeight);

  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 8; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? '#ffffff' : '#000000';
      ctx.fillRect(col * 8, row * 8, 8, 8);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;

  const bannerMat = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.1 });

  const banner = new THREE.Mesh(bannerGeo, bannerMat);
  banner.position.set(pos.x, trackY + bannerHeight / 2 + 0.5, pos.z);
  banner.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
  scene.add(banner);
  finishLineMeshes.push(banner);

  const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, bannerHeight + 1.2, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.4, metalness: 0.6 });

  const poleLeft = new THREE.Mesh(poleGeo, poleMat);
  poleLeft.position.set(pos.x - right.x * (halfW + 0.1), trackY + (bannerHeight + 1.2) / 2 - 0.1, pos.z - right.z * (halfW + 0.1));
  scene.add(poleLeft);
  finishLineMeshes.push(poleLeft);

  const poleRight = new THREE.Mesh(poleGeo, poleMat);
  poleRight.position.set(pos.x + right.x * (halfW + 0.1), trackY + (bannerHeight + 1.2) / 2 - 0.1, pos.z + right.z * (halfW + 0.1));
  scene.add(poleRight);
  finishLineMeshes.push(poleRight);

  const lineGeo = new THREE.PlaneGeometry(TRACK_WIDTH, 0.3);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.3 });
  const line = new THREE.Mesh(lineGeo, lineMat);
  line.position.set(pos.x, trackY + 0.01, pos.z);
  line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  const yaw = Math.atan2(tangent.x, tangent.z);
  line.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), yaw);
  scene.add(line);
  finishLineMeshes.push(line);
}

function generateObstacles() {
  const rng = seededRandom(globalSeed);
  const obstacles = [];
  const halfTrack = TRACK_WIDTH / 2;
  let d = SAFE_ZONE_DISTANCE;
  const endD = FINISH_LINE_DISTANCE - 5;

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

function generateCoins(obstacles) {
  const rng = seededRandom(globalSeed + 9973);
  const coins = [];
  const halfTrack = TRACK_WIDTH / 2;
  const endD = FINISH_LINE_DISTANCE - 3;

  for (let i = 0; i < obstacles.length; i++) {
    const sD = i === 0 ? SAFE_ZONE_DISTANCE + 1 : obstacles[i - 1].distance + 1;
    const eD = obstacles[i].distance - 1;
    const gap = eD - sD;
    if (gap < 2) continue;
    const count = gap >= 5 ? 3 : 2;
    const step = gap / (count + 1);
    for (let j = 1; j <= count; j++) {
      coins.push({ distance: sD + step * j, lateral: (rng() * 2 - 1) * (halfTrack - 0.5) });
    }
  }

  const lastD = obstacles.length > 0 ? obstacles[obstacles.length - 1].distance + 1 : SAFE_ZONE_DISTANCE + 1;
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

function generateTurtles(obstacles) {
  const rng = seededRandom(globalSeed + 4201);
  const turtles = [];
  const halfTrack = TRACK_WIDTH / 2;
  const endD = FINISH_LINE_DISTANCE - 5;

  for (let segStart = SAFE_ZONE_DISTANCE + 10; segStart < endD; segStart += TURTLE_SEGMENT_LENGTH) {
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

function generateMovingWalls(staticObstacles) {
  const rng = seededRandom(globalSeed + 7777);
  const walls = [];
  const endD = FINISH_LINE_DISTANCE - 5;
  let d = MOVING_WALL_START_DISTANCE;

  while (d < endD) {
    const spacing = MOVING_WALL_MIN_SPACING + rng() * (MOVING_WALL_MAX_SPACING - MOVING_WALL_MIN_SPACING);
    d += spacing;
    if (d >= endD) break;

    // Avoid placing too close to static obstacles
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
      speed,
      range,
      phase,
      currentLateral: 0,
    });
  }
  return walls;
}

function placeMovingWalls(wallData) {
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
    movingWallEntries.push({ mesh, data: { ...w, id: 'mw_' + i } });
  }
}

function placeObstacles(obstacleData) {
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
    obstacleMeshes.push(mesh);
  }
}

function placeCoins(coinData) {
  for (let i = 0; i < coinData.length; i++) {
    const c = coinData[i];
    const worldPos = trackToWorld(c.distance, c.lateral);
    const mesh = new THREE.Mesh(coinGeo, coinMat);
    mesh.position.set(worldPos.x, worldPos.y + TRACK_HEIGHT / 2 + 0.35, worldPos.z);
    mesh.rotation.x = Math.PI / 2;
    scene.add(mesh);
    coinEntries.push({ mesh, data: { distance: c.distance, lateral: c.lateral, id: 'c_' + i } });
  }
}

function placeTurtles(turtleData) {
  for (let i = 0; i < turtleData.length; i++) {
    const t = turtleData[i];
    const worldPos = trackToWorld(t.distance, t.lateral);
    const mesh = createTurtleMesh();
    mesh.position.set(worldPos.x, worldPos.y + TRACK_HEIGHT / 2 + 0.35, worldPos.z);
    scene.add(mesh);
    turtleEntries.push({ mesh, data: { distance: t.distance, lateral: t.lateral, id: 't_' + i } });
  }
}

let obstacleDataCache = [];

function buildFullTrack() {
  buildTrackMesh();
  buildFinishLine();
  obstacleDataCache = generateObstacles();
  const coinData = generateCoins(obstacleDataCache);
  const turtleData = generateTurtles(obstacleDataCache);
  const movingWallData = generateMovingWalls(obstacleDataCache);
  placeObstacles(obstacleDataCache);
  placeCoins(coinData);
  placeTurtles(turtleData);
  placeMovingWalls(movingWallData);
}

function clearTrack() {
  for (const m of trackMeshes) scene.remove(m);
  for (const m of edgeMeshes) scene.remove(m);
  for (const m of obstacleMeshes) scene.remove(m);
  for (const e of coinEntries) scene.remove(e.mesh);
  for (const e of turtleEntries) {
    e.mesh.traverse((child) => { if (child.isMesh) { child.geometry.dispose(); child.material.dispose(); } });
    scene.remove(e.mesh);
  }
  for (const e of movingWallEntries) scene.remove(e.mesh);
  for (const m of finishLineMeshes) scene.remove(m);
  trackMeshes = [];
  edgeMeshes = [];
  obstacleMeshes = [];
  coinEntries = [];
  turtleEntries = [];
  movingWallEntries = [];
  finishLineMeshes = [];
  obstacleDataCache = [];
}

export function initRenderer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 40, 120);

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

  buildFullTrack();
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
    ballStartDistance: BALL_START_DISTANCE, finishLineDistance: FINISH_LINE_DISTANCE,
    trackLength: getTrackLength(),
  };
}

export function resetTrack() {
  clearTrack();
  globalSeed = Date.now();
  buildFullTrack();
  cameraInitialized = false;
}

export function getActiveObstacles() {
  const result = obstacleDataCache.map((o) => ({ distance: o.distance, lateral: o.lateral, halfW: o.halfW, halfD: o.halfD, height: OBSTACLE_HEIGHT }));
  for (const entry of movingWallEntries) {
    const w = entry.data;
    result.push({
      distance: w.distance,
      lateral: w.currentLateral,
      halfW: w.halfW,
      halfD: w.halfD,
      height: MOVING_WALL_HEIGHT,
    });
  }
  return result;
}

export function getActiveCoins() {
  const result = [];
  for (const entry of coinEntries) { if (entry.mesh.visible) result.push(entry.data); }
  return result;
}

export function getActiveTurtles() {
  const result = [];
  for (const entry of turtleEntries) { if (entry.mesh.visible) result.push(entry.data); }
  return result;
}

export function hideCoinById(coinId) {
  for (const entry of coinEntries) { if (entry.data.id === coinId) { entry.mesh.visible = false; return; } }
}

export function hideTurtleById(turtleId) {
  for (const entry of turtleEntries) { if (entry.data.id === turtleId) { entry.mesh.visible = false; return; } }
}

export function updateSceneColors(hexColor) {
  const color = new THREE.Color(hexColor);
  scene.background = color;
  scene.fog.color = color;
}

export function updateCoinRotation(dt) {
  for (const entry of coinEntries) { if (entry.mesh.visible) entry.mesh.rotation.y += 2.0 * dt; }
  for (const entry of turtleEntries) { if (entry.mesh.visible) entry.mesh.rotation.y += 1.5 * dt; }
}

export function updateMovingWalls(timestamp) {
  const time = timestamp / 1000;
  for (const entry of movingWallEntries) {
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
