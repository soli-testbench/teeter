import * as THREE from 'three';

// Track dimensions
const TRACK_WIDTH = 4.5;
const TRACK_HEIGHT = 0.2;
const BALL_RADIUS = 0.3;
const BALL_START_Z = -20;

// Rolling track configuration
const CHUNK_LENGTH = 20;
const LOOKAHEAD_DISTANCE = 60;
const CLEANUP_DISTANCE = 20;

// Obstacle config
const OBSTACLE_WIDTH = 1.5;
const OBSTACLE_HEIGHT = 1.0;
const OBSTACLE_DEPTH = 0.4;
const OBSTACLE_MIN_SPACING = 7;
const OBSTACLE_MAX_SPACING = 9;
const SAFE_ZONE_END = BALL_START_Z + 5; // No obstacles/coins before Z = -15
const MIN_GAP = 1.5; // Minimum passable gap beside obstacle

// Coin config
const COIN_RADIUS = 0.25;
const COIN_TUBE = 0.08;
const COIN_Y = TRACK_HEIGHT / 2 + 0.35;

// Turtle config
const TURTLE_SPAWN_CHANCE = 0.3; // 30% chance per chunk

let scene, camera, renderer, dirLight;
let ballMesh;

// Chunk management
let chunks = new Map(); // chunkIndex -> chunk data
let globalSeed = Date.now();

// Simple seeded RNG for deterministic placement
function seededRandom(seed) {
  let s = Math.abs(Math.floor(seed)) || 1;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Shared geometries and materials (reused across all chunks)
const obstGeo = new THREE.BoxGeometry(OBSTACLE_WIDTH, OBSTACLE_HEIGHT, OBSTACLE_DEPTH);
const obstMat = new THREE.MeshStandardMaterial({
  color: 0x8B2222,
  roughness: 0.5,
  metalness: 0.2,
});
const coinGeo = new THREE.TorusGeometry(COIN_RADIUS, COIN_TUBE, 12, 24);
const coinMat = new THREE.MeshStandardMaterial({
  color: 0xFFD700,
  metalness: 0.8,
  roughness: 0.2,
  emissive: 0x554400,
  emissiveIntensity: 0.3,
});
const trackMat = new THREE.MeshStandardMaterial({
  color: 0x8B7355,
  roughness: 0.7,
  metalness: 0.1,
});
const edgeMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.6 });
const chunkTrackGeo = new THREE.BoxGeometry(TRACK_WIDTH, TRACK_HEIGHT, CHUNK_LENGTH);
const chunkEdgeGeo = new THREE.BoxGeometry(0.06, 0.08, CHUNK_LENGTH);

function generateChunkObstacles(rng, zStart, zEnd) {
  const obstacles = [];
  const halfTrack = TRACK_WIDTH / 2;

  // Start obstacles after safe zone or a small offset into the chunk
  let z = Math.max(zStart + 2, SAFE_ZONE_END);
  if (z >= zEnd - 1) return obstacles;

  while (z < zEnd - 1) {
    const spacing = OBSTACLE_MIN_SPACING + rng() * (OBSTACLE_MAX_SPACING - OBSTACLE_MIN_SPACING);
    z += spacing;
    if (z >= zEnd - 1) break;

    // Place obstacle so there is at least MIN_GAP on one side
    const maxOffset = halfTrack - OBSTACLE_WIDTH / 2 - 0.1;
    const x = (rng() * 2 - 1) * maxOffset;

    obstacles.push({
      x,
      z,
      halfW: OBSTACLE_WIDTH / 2,
      halfD: OBSTACLE_DEPTH / 2,
    });
  }
  return obstacles;
}

function generateChunkCoins(rng, obstacles, zStart, zEnd) {
  const coins = [];
  const halfTrack = TRACK_WIDTH / 2;

  const effectiveStart = Math.max(zStart, SAFE_ZONE_END);
  if (effectiveStart >= zEnd) return coins;

  // Place 2-3 coins between each pair of obstacles
  for (let i = 0; i < obstacles.length; i++) {
    const sZ = i === 0 ? effectiveStart + 1 : obstacles[i - 1].z + 1;
    const eZ = obstacles[i].z - 1;
    const gap = eZ - sZ;
    if (gap < 2) continue;

    const count = gap >= 5 ? 3 : 2;
    const step = gap / (count + 1);

    for (let j = 1; j <= count; j++) {
      const cz = sZ + step * j;
      const cx = (rng() * 2 - 1) * (halfTrack - 0.5);
      coins.push({ x: cx, z: cz });
    }
  }

  // Coins after last obstacle (or throughout chunk if no obstacles)
  const lastZ = obstacles.length > 0 ? obstacles[obstacles.length - 1].z + 1 : effectiveStart + 1;
  const gap = zEnd - 1 - lastZ;
  if (gap >= 3) {
    const count = Math.min(3, Math.max(2, Math.floor(gap / 4)));
    const step = gap / (count + 1);
    for (let j = 1; j <= count; j++) {
      const cz = lastZ + step * j;
      const cx = (rng() * 2 - 1) * (halfTrack - 0.5);
      coins.push({ x: cx, z: cz });
    }
  }

  // Guarantee at least some coins if chunk is past safe zone
  if (coins.length === 0 && effectiveStart + 2 < zEnd - 1) {
    const range = zEnd - 1 - (effectiveStart + 1);
    if (range > 2) {
      const count = Math.max(2, Math.floor(range / 5));
      const step = range / (count + 1);
      for (let j = 1; j <= count; j++) {
        const cz = effectiveStart + 1 + step * j;
        const cx = (rng() * 2 - 1) * (halfTrack - 0.5);
        coins.push({ x: cx, z: cz });
      }
    }
  }

  return coins;
}

function createTurtleMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x228B22, roughness: 0.6, metalness: 0.1 });
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x185818, roughness: 0.5, metalness: 0.15 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x2EA52E, roughness: 0.5, metalness: 0.1 });

  // Shell (flattened sphere)
  const shellGeo = new THREE.SphereGeometry(0.4, 16, 12);
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.scale.set(1, 0.5, 1.1);
  shell.position.y = 0.1;
  group.add(shell);

  // Body (slightly smaller, underneath shell)
  const bodyGeo = new THREE.SphereGeometry(0.35, 12, 10);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.scale.set(1, 0.35, 1.05);
  body.position.y = -0.02;
  group.add(body);

  // Head (small sphere at front)
  const headGeo = new THREE.SphereGeometry(0.12, 10, 8);
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.set(0, 0.05, 0.42);
  group.add(head);

  // Legs (4 flattened cylinders)
  const legGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 6);
  const legPositions = [
    { x: -0.22, z: 0.2 },
    { x: 0.22, z: 0.2 },
    { x: -0.22, z: -0.2 },
    { x: 0.22, z: -0.2 },
  ];
  for (const pos of legPositions) {
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.set(pos.x, -0.1, pos.z);
    group.add(leg);
  }

  return group;
}

function generateChunkTurtle(rng, obstacles, zStart, zEnd) {
  const halfTrack = TRACK_WIDTH / 2;
  const minZ = Math.max(zStart + 2, SAFE_ZONE_END + 3);
  const maxZ = zEnd - 2;

  if (maxZ <= minZ) return null;

  // Pick a random Z, avoiding obstacle zones
  let attempts = 0;
  while (attempts < 20) {
    const z = minZ + rng() * (maxZ - minZ);
    let clear = true;
    for (const o of obstacles) {
      if (Math.abs(z - o.z) < 2) {
        clear = false;
        break;
      }
    }
    if (clear) {
      const x = (rng() * 2 - 1) * (halfTrack - 0.5);
      return { x, z };
    }
    attempts++;
  }

  return null; // Do not force placement if no clear spot
}

function generateChunk(chunkIndex) {
  const zStart = chunkIndex * CHUNK_LENGTH;
  const zEnd = zStart + CHUNK_LENGTH;
  const zCenter = (zStart + zEnd) / 2;

  // Track section mesh
  const tMesh = new THREE.Mesh(chunkTrackGeo, trackMat);
  tMesh.position.set(0, 0, zCenter);
  tMesh.receiveShadow = true;
  scene.add(tMesh);

  // Edge lines
  const eLeft = new THREE.Mesh(chunkEdgeGeo, edgeMat);
  eLeft.position.set(-TRACK_WIDTH / 2, TRACK_HEIGHT / 2 + 0.04, zCenter);
  scene.add(eLeft);

  const eRight = new THREE.Mesh(chunkEdgeGeo, edgeMat);
  eRight.position.set(TRACK_WIDTH / 2, TRACK_HEIGHT / 2 + 0.04, zCenter);
  scene.add(eRight);

  // Generate content with chunk-specific seed
  const rng = seededRandom(globalSeed + chunkIndex * 7919);
  const obsData = generateChunkObstacles(rng, zStart, zEnd);
  const cData = generateChunkCoins(rng, obsData, zStart, zEnd);

  // Create obstacle meshes
  const oMeshes = obsData.map((o) => {
    const mesh = new THREE.Mesh(obstGeo, obstMat);
    mesh.position.set(o.x, TRACK_HEIGHT / 2 + OBSTACLE_HEIGHT / 2, o.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  });

  // Create coin meshes with unique IDs
  const coinEntries = cData.map((c, i) => {
    const mesh = new THREE.Mesh(coinGeo, coinMat);
    mesh.position.set(c.x, COIN_Y, c.z);
    mesh.rotation.x = Math.PI / 2;
    scene.add(mesh);
    return { mesh, data: { x: c.x, z: c.z, id: 'c_' + chunkIndex + '_' + i } };
  });

  // Maybe generate turtle powerup (30% chance per chunk)
  let turtleEntry = null;
  if (rng() < TURTLE_SPAWN_CHANCE) {
    const td = generateChunkTurtle(rng, obsData, zStart, zEnd);
    if (td) {
      const turtleMesh = createTurtleMesh();
      turtleMesh.position.set(td.x, COIN_Y, td.z);
      scene.add(turtleMesh);
      turtleEntry = { mesh: turtleMesh, data: { x: td.x, z: td.z, id: 't_' + chunkIndex } };
    }
  }

  chunks.set(chunkIndex, {
    index: chunkIndex,
    zStart,
    zEnd,
    trackMesh: tMesh,
    edgeLeft: eLeft,
    edgeRight: eRight,
    obstacleMeshes: oMeshes,
    obstacleData: obsData.map((o) => ({
      x: o.x,
      z: o.z,
      halfW: o.halfW,
      halfD: o.halfD,
      height: OBSTACLE_HEIGHT,
    })),
    coinEntries,
    turtleEntry,
  });
}

function disposeChunk(chunkIndex) {
  const chunk = chunks.get(chunkIndex);
  if (!chunk) return;

  // Remove track and edge meshes from scene
  scene.remove(chunk.trackMesh);
  scene.remove(chunk.edgeLeft);
  scene.remove(chunk.edgeRight);

  // Remove obstacle meshes
  for (const mesh of chunk.obstacleMeshes) {
    scene.remove(mesh);
  }

  // Remove coin meshes
  for (const entry of chunk.coinEntries) {
    scene.remove(entry.mesh);
  }

  // Remove and dispose turtle mesh (has unique geometries/materials)
  if (chunk.turtleEntry) {
    chunk.turtleEntry.mesh.traverse((child) => {
      if (child.isMesh) {
        child.geometry.dispose();
        child.material.dispose();
      }
    });
    scene.remove(chunk.turtleEntry.mesh);
  }

  chunks.delete(chunkIndex);
}

export function updateRollingTrack(ballZ) {
  const currentChunk = Math.floor(ballZ / CHUNK_LENGTH);
  const minChunk = currentChunk - Math.ceil(CLEANUP_DISTANCE / CHUNK_LENGTH);
  const maxChunk = currentChunk + Math.ceil(LOOKAHEAD_DISTANCE / CHUNK_LENGTH);

  // Generate new chunks in the lookahead range
  for (let i = minChunk; i <= maxChunk; i++) {
    if (!chunks.has(i)) {
      generateChunk(i);
    }
  }

  // Remove old chunks behind the ball
  for (const [idx] of chunks) {
    if (idx < minChunk) {
      disposeChunk(idx);
    }
  }
}

export function resetRollingTrack() {
  // Remove all existing chunks
  for (const [idx] of chunks) {
    disposeChunk(idx);
  }
  chunks.clear();

  // New seed for different layout
  globalSeed = Date.now();

  // Generate initial chunks around ball start
  updateRollingTrack(BALL_START_Z);
}

export function getActiveObstacles() {
  const result = [];
  for (const [, chunk] of chunks) {
    for (const o of chunk.obstacleData) {
      result.push(o);
    }
  }
  return result;
}

export function getActiveCoins() {
  const result = [];
  for (const [, chunk] of chunks) {
    for (const entry of chunk.coinEntries) {
      if (entry.mesh.visible) {
        result.push(entry.data);
      }
    }
  }
  return result;
}

export function getActiveTurtles() {
  const result = [];
  for (const [, chunk] of chunks) {
    if (chunk.turtleEntry && chunk.turtleEntry.mesh.visible) {
      result.push(chunk.turtleEntry.data);
    }
  }
  return result;
}

export function hideCoinById(coinId) {
  for (const [, chunk] of chunks) {
    for (const entry of chunk.coinEntries) {
      if (entry.data.id === coinId) {
        entry.mesh.visible = false;
        return;
      }
    }
  }
}

export function hideTurtleById(turtleId) {
  for (const [, chunk] of chunks) {
    if (chunk.turtleEntry && chunk.turtleEntry.data.id === turtleId) {
      chunk.turtleEntry.mesh.visible = false;
      return;
    }
  }
}

export function initRenderer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 30, 80);

  // Camera
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 4, BALL_START_Z - 8);
  camera.lookAt(0, 0, BALL_START_Z);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // Lighting
  const ambient = new THREE.AmbientLight(0x404060, 0.8);
  scene.add(ambient);

  dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, BALL_START_Z + 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 60;
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 30;
  dirLight.shadow.camera.bottom = -30;
  scene.add(dirLight);
  scene.add(dirLight.target);

  // Ball
  const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 32, 32);
  const ballMat = new THREE.MeshStandardMaterial({
    color: 0xff4444,
    metalness: 0.3,
    roughness: 0.4,
  });
  ballMesh = new THREE.Mesh(ballGeo, ballMat);
  ballMesh.castShadow = true;
  ballMesh.position.set(0, TRACK_HEIGHT / 2 + BALL_RADIUS, BALL_START_Z);
  scene.add(ballMesh);

  // Generate initial track chunks around ball start
  updateRollingTrack(BALL_START_Z);

  // Handle resize
  window.addEventListener('resize', onResize);

  return { scene, camera, renderer };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

export function updateBallPosition(x, y, z) {
  ballMesh.position.set(x, y, z);
}

export function resetBallRotation() {
  ballMesh.rotation.set(0, 0, 0);
}

export function updateBallRotation(vx, vz, dt) {
  // Rolling rotation: x-axis for forward motion, z-axis for lateral
  ballMesh.rotation.x -= (vz / BALL_RADIUS) * dt;
  ballMesh.rotation.z += (vx / BALL_RADIUS) * dt;
}

export function updateCamera(ballZ) {
  camera.position.z = ballZ - 8;
  camera.position.y = 4;
  camera.lookAt(0, 0, ballZ);

  // Move directional light to follow ball for proper shadows
  dirLight.position.set(5, 10, ballZ + 5);
  dirLight.target.position.set(0, 0, ballZ);
}

export function render() {
  renderer.render(scene, camera);
}

export function getTrackConfig() {
  return {
    trackWidth: TRACK_WIDTH,
    trackHeight: TRACK_HEIGHT,
    ballRadius: BALL_RADIUS,
    ballStartZ: BALL_START_Z,
  };
}

export function updateSceneColors(hexColor) {
  const color = new THREE.Color(hexColor);
  scene.background = color;
  scene.fog.color = color;
}

export function updateCoinRotation(dt) {
  for (const [, chunk] of chunks) {
    for (const entry of chunk.coinEntries) {
      if (entry.mesh.visible) {
        entry.mesh.rotation.y += 2.0 * dt;
      }
    }
    // Rotate turtle powerup too
    if (chunk.turtleEntry && chunk.turtleEntry.mesh.visible) {
      chunk.turtleEntry.mesh.rotation.y += 1.5 * dt;
    }
  }
}
