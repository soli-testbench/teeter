import * as THREE from 'three';

const TRACK_WIDTH = 4.5;
const TRACK_HEIGHT = 0.2;
const BALL_RADIUS = 0.3;

// Obstacle config
const OBSTACLE_WIDTH = 1.5;
const OBSTACLE_HEIGHT = 1.0;
const OBSTACLE_DEPTH = 0.4;
const OBSTACLE_MIN_SPACING = 0.04; // In t-space (~5.6 world units on 140-unit curve)
const OBSTACLE_MAX_SPACING = 0.06;
const SAFE_ZONE_T = 0.05; // No obstacles before 5% of curve
const MIN_GAP = 1.5;

// Coin config
const COIN_RADIUS = 0.25;
const COIN_TUBE = 0.08;

const NUM_TRACK_SAMPLES = 300;

// Curve control points — winding, gently downhill path
const CONTROL_POINTS = [
  new THREE.Vector3(0, 10, 0),
  new THREE.Vector3(0, 9.5, 10),
  new THREE.Vector3(3, 8.5, 25),
  new THREE.Vector3(5, 7.5, 40),
  new THREE.Vector3(3, 6.5, 55),
  new THREE.Vector3(-3, 5.5, 70),
  new THREE.Vector3(-5, 4.5, 85),
  new THREE.Vector3(-2, 3.0, 100),
  new THREE.Vector3(2, 1.5, 115),
  new THREE.Vector3(2, 0.5, 130),
  new THREE.Vector3(0, 0, 140),
];

let curve = null;
let curveLength = 0;

let scene, camera, renderer;
let ballMesh;
let trackGroup;
let finishLineMesh;

let obstacleMeshes = [];
let obstacleData = [];
let coinMeshes = [];
let coinData = [];
let turtleMesh = null;
let turtleData = null;

// Shared geometry and materials
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

// Simple seeded RNG
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function buildCurve() {
  curve = new THREE.CatmullRomCurve3(CONTROL_POINTS, false, 'centripetal', 0.5);
  curveLength = curve.getLength();
}

// Get lateral vector at a point on the curve (perpendicular to tangent, in the horizontal-ish plane)
function getLateral(t) {
  const tangent = curve.getTangentAt(t);
  const up = new THREE.Vector3(0, 1, 0);
  const lateral = new THREE.Vector3().crossVectors(tangent, up).normalize();
  // If tangent is nearly vertical, fallback
  if (lateral.lengthSq() < 0.001) {
    lateral.set(1, 0, 0);
  }
  return lateral;
}

function getTrackUp(t) {
  const tangent = curve.getTangentAt(t);
  const lateral = getLateral(t);
  return new THREE.Vector3().crossVectors(lateral, tangent).normalize();
}

function buildTrackMesh() {
  trackGroup = new THREE.Group();

  const positions = [];
  const normals = [];
  const indices = [];
  const uvs = [];

  const halfWidth = TRACK_WIDTH / 2;

  // Build ribbon geometry
  for (let i = 0; i <= NUM_TRACK_SAMPLES; i++) {
    const t = i / NUM_TRACK_SAMPLES;
    const point = curve.getPointAt(t);
    const lateral = getLateral(t);
    const trackUp = getTrackUp(t);

    const left = point.clone().add(lateral.clone().multiplyScalar(-halfWidth));
    const right = point.clone().add(lateral.clone().multiplyScalar(halfWidth));

    // Raise by track height/2 so surface is on top
    const yOffset = trackUp.clone().multiplyScalar(TRACK_HEIGHT / 2);
    left.add(yOffset);
    right.add(yOffset);

    positions.push(left.x, left.y, left.z);
    positions.push(right.x, right.y, right.z);

    normals.push(trackUp.x, trackUp.y, trackUp.z);
    normals.push(trackUp.x, trackUp.y, trackUp.z);

    uvs.push(0, t);
    uvs.push(1, t);

    if (i < NUM_TRACK_SAMPLES) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  // Also build underside for thickness
  const topVertCount = (NUM_TRACK_SAMPLES + 1) * 2;
  for (let i = 0; i <= NUM_TRACK_SAMPLES; i++) {
    const t = i / NUM_TRACK_SAMPLES;
    const point = curve.getPointAt(t);
    const lateral = getLateral(t);
    const trackUp = getTrackUp(t);

    const left = point.clone().add(lateral.clone().multiplyScalar(-halfWidth));
    const right = point.clone().add(lateral.clone().multiplyScalar(halfWidth));

    const yOffset = trackUp.clone().multiplyScalar(-TRACK_HEIGHT / 2);
    left.add(yOffset);
    right.add(yOffset);

    positions.push(left.x, left.y, left.z);
    positions.push(right.x, right.y, right.z);

    const downNorm = trackUp.clone().negate();
    normals.push(downNorm.x, downNorm.y, downNorm.z);
    normals.push(downNorm.x, downNorm.y, downNorm.z);

    uvs.push(0, t);
    uvs.push(1, t);

    if (i < NUM_TRACK_SAMPLES) {
      const base = topVertCount + i * 2;
      indices.push(base, base + 2, base + 1);
      indices.push(base + 1, base + 2, base + 3);
    }
  }

  // Side faces (left edge and right edge)
  const sideStart = positions.length / 3;
  for (let i = 0; i <= NUM_TRACK_SAMPLES; i++) {
    const t = i / NUM_TRACK_SAMPLES;
    const point = curve.getPointAt(t);
    const lateral = getLateral(t);
    const trackUp = getTrackUp(t);

    const halfH = TRACK_HEIGHT / 2;
    // Left edge
    const leftTop = point.clone()
      .add(lateral.clone().multiplyScalar(-halfWidth))
      .add(trackUp.clone().multiplyScalar(halfH));
    const leftBot = point.clone()
      .add(lateral.clone().multiplyScalar(-halfWidth))
      .add(trackUp.clone().multiplyScalar(-halfH));

    const leftNorm = lateral.clone().negate();

    positions.push(leftTop.x, leftTop.y, leftTop.z);
    positions.push(leftBot.x, leftBot.y, leftBot.z);
    normals.push(leftNorm.x, leftNorm.y, leftNorm.z);
    normals.push(leftNorm.x, leftNorm.y, leftNorm.z);
    uvs.push(0, t);
    uvs.push(0, t);

    if (i < NUM_TRACK_SAMPLES) {
      const base = sideStart + i * 2;
      indices.push(base, base + 2, base + 1);
      indices.push(base + 1, base + 2, base + 3);
    }
  }

  const rightStart = positions.length / 3;
  for (let i = 0; i <= NUM_TRACK_SAMPLES; i++) {
    const t = i / NUM_TRACK_SAMPLES;
    const point = curve.getPointAt(t);
    const lateral = getLateral(t);
    const trackUp = getTrackUp(t);

    const halfH = TRACK_HEIGHT / 2;
    const rightTop = point.clone()
      .add(lateral.clone().multiplyScalar(halfWidth))
      .add(trackUp.clone().multiplyScalar(halfH));
    const rightBot = point.clone()
      .add(lateral.clone().multiplyScalar(halfWidth))
      .add(trackUp.clone().multiplyScalar(-halfH));

    positions.push(rightTop.x, rightTop.y, rightTop.z);
    positions.push(rightBot.x, rightBot.y, rightBot.z);
    normals.push(lateral.x, lateral.y, lateral.z);
    normals.push(lateral.x, lateral.y, lateral.z);
    uvs.push(1, t);
    uvs.push(1, t);

    if (i < NUM_TRACK_SAMPLES) {
      const base = rightStart + i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  const trackMat = new THREE.MeshStandardMaterial({
    color: 0x8B7355,
    roughness: 0.7,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });

  const trackMesh = new THREE.Mesh(geo, trackMat);
  trackMesh.receiveShadow = true;
  trackGroup.add(trackMesh);

  // Edge lines
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.6 });
  const edgeRadius = 0.04;
  const edgeSegments = NUM_TRACK_SAMPLES;

  // Build edge line as a tube along left and right edges
  const leftPoints = [];
  const rightPoints = [];
  for (let i = 0; i <= edgeSegments; i++) {
    const t = i / edgeSegments;
    const point = curve.getPointAt(t);
    const lateral = getLateral(t);
    const trackUp = getTrackUp(t);
    const yOff = trackUp.clone().multiplyScalar(TRACK_HEIGHT / 2 + edgeRadius);

    leftPoints.push(point.clone().add(lateral.clone().multiplyScalar(-halfWidth)).add(yOff));
    rightPoints.push(point.clone().add(lateral.clone().multiplyScalar(halfWidth)).add(yOff));
  }

  const leftCurve = new THREE.CatmullRomCurve3(leftPoints);
  const rightCurve = new THREE.CatmullRomCurve3(rightPoints);

  const edgeGeoL = new THREE.TubeGeometry(leftCurve, edgeSegments, edgeRadius, 6, false);
  const edgeGeoR = new THREE.TubeGeometry(rightCurve, edgeSegments, edgeRadius, 6, false);

  const edgeLeft = new THREE.Mesh(edgeGeoL, edgeMat);
  const edgeRight = new THREE.Mesh(edgeGeoR, edgeMat);
  trackGroup.add(edgeLeft);
  trackGroup.add(edgeRight);

  scene.add(trackGroup);
}

function buildFinishLine() {
  // Create a checkerboard texture via canvas
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const numChecks = 8;
  const checkW = canvas.width / numChecks;
  const checkH = canvas.height / 2;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < numChecks; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(col * checkW, row * checkH, checkW, checkH);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;

  const finishGeo = new THREE.PlaneGeometry(TRACK_WIDTH, 1.5);
  const finishMat = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.4,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  finishLineMesh = new THREE.Mesh(finishGeo, finishMat);

  // Position at end of curve
  const endPoint = curve.getPointAt(1.0);
  const tangent = curve.getTangentAt(1.0);
  const lateral = getLateral(1.0);
  const trackUp = getTrackUp(1.0);

  finishLineMesh.position.copy(endPoint);
  finishLineMesh.position.add(trackUp.clone().multiplyScalar(TRACK_HEIGHT / 2 + 0.01));

  // Orient to face along tangent, lying on track surface
  const lookTarget = endPoint.clone().add(trackUp);
  finishLineMesh.lookAt(lookTarget);
  // Rotate to align width with lateral direction
  const quat = new THREE.Quaternion();
  const mat4 = new THREE.Matrix4();
  mat4.makeBasis(lateral, trackUp, tangent);
  quat.setFromRotationMatrix(mat4);
  finishLineMesh.quaternion.copy(quat);
  // Shift slightly up off surface
  finishLineMesh.position.add(trackUp.clone().multiplyScalar(0.02));

  scene.add(finishLineMesh);

  // Add vertical finish banner poles
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5 });
  const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 8);
  const poleLeft = new THREE.Mesh(poleGeo, poleMat);
  const poleRight = new THREE.Mesh(poleGeo, poleMat);

  const poleBase = endPoint.clone().add(trackUp.clone().multiplyScalar(TRACK_HEIGHT / 2 + 1.25));
  poleLeft.position.copy(poleBase.clone().add(lateral.clone().multiplyScalar(-TRACK_WIDTH / 2)));
  poleRight.position.copy(poleBase.clone().add(lateral.clone().multiplyScalar(TRACK_WIDTH / 2)));

  // Align poles with track up direction
  const poleQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), trackUp);
  poleLeft.quaternion.copy(poleQuat);
  poleRight.quaternion.copy(poleQuat);

  scene.add(poleLeft);
  scene.add(poleRight);

  // Banner across top
  const bannerGeo = new THREE.PlaneGeometry(TRACK_WIDTH, 0.4);
  const bannerCanvas = document.createElement('canvas');
  bannerCanvas.width = 256;
  bannerCanvas.height = 32;
  const bctx = bannerCanvas.getContext('2d');
  // Checkerboard banner
  for (let col = 0; col < 16; col++) {
    bctx.fillStyle = col % 2 === 0 ? '#ffffff' : '#111111';
    bctx.fillRect(col * 16, 0, 16, 32);
  }
  const bannerTex = new THREE.CanvasTexture(bannerCanvas);
  const bannerMat = new THREE.MeshStandardMaterial({
    map: bannerTex,
    side: THREE.DoubleSide,
    roughness: 0.4,
  });
  const bannerMesh = new THREE.Mesh(bannerGeo, bannerMat);
  bannerMesh.position.copy(poleBase.clone().add(trackUp.clone().multiplyScalar(1.25)));
  const bannerQuat = new THREE.Quaternion();
  const bannerBasis = new THREE.Matrix4().makeBasis(lateral, trackUp, tangent);
  bannerQuat.setFromRotationMatrix(bannerBasis);
  bannerMesh.quaternion.copy(bannerQuat);
  scene.add(bannerMesh);
}

function createTurtleMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x228B22, roughness: 0.6, metalness: 0.1 });
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x185818, roughness: 0.5, metalness: 0.15 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x2EA52E, roughness: 0.5, metalness: 0.1 });

  const shellGeo = new THREE.SphereGeometry(0.4, 16, 12);
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.scale.set(1, 0.5, 1.1);
  shell.position.y = 0.1;
  group.add(shell);

  const bodyGeo = new THREE.SphereGeometry(0.35, 12, 10);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.scale.set(1, 0.35, 1.05);
  body.position.y = -0.02;
  group.add(body);

  const headGeo = new THREE.SphereGeometry(0.12, 10, 8);
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.set(0, 0.05, 0.42);
  group.add(head);

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

function generateObstacles(rng) {
  const obstacles = [];
  const halfTrack = TRACK_WIDTH / 2;

  let t = SAFE_ZONE_T;
  const endT = 0.95; // Stop before finish line
  while (t < endT) {
    const spacing = OBSTACLE_MIN_SPACING + rng() * (OBSTACLE_MAX_SPACING - OBSTACLE_MIN_SPACING);
    t += spacing;
    if (t >= endT) break;

    // Place obstacle with lateral offset
    const maxOffset = halfTrack - OBSTACLE_WIDTH / 2 - 0.1;
    const d = (rng() * 2 - 1) * maxOffset;

    // Convert to world position for mesh placement
    const point = curve.getPointAt(t);
    const lateral = getLateral(t);
    const trackUp = getTrackUp(t);
    const tangent = curve.getTangentAt(t);

    const worldPos = point.clone()
      .add(lateral.clone().multiplyScalar(d))
      .add(trackUp.clone().multiplyScalar(TRACK_HEIGHT / 2 + OBSTACLE_HEIGHT / 2));

    obstacles.push({
      t,
      d,
      halfW: OBSTACLE_WIDTH / 2,
      halfD: OBSTACLE_DEPTH / 2,
      worldPos,
      tangent: tangent.clone(),
      lateral: lateral.clone(),
      trackUp: trackUp.clone(),
    });
  }
  return obstacles;
}

function generateCoins(rng, obstacles) {
  const coins = [];
  const halfTrack = TRACK_WIDTH / 2;

  for (let i = 0; i < obstacles.length; i++) {
    const startT = i === 0 ? SAFE_ZONE_T : obstacles[i - 1].t + 0.005;
    const endT = obstacles[i].t - 0.005;
    const gap = endT - startT;
    if (gap < 0.01) continue;

    const count = gap >= 0.03 ? 3 : 2;
    const step = gap / (count + 1);

    for (let j = 1; j <= count; j++) {
      const ct = startT + step * j;
      const cd = (rng() * 2 - 1) * (halfTrack - 0.5);
      coins.push({ t: ct, d: cd });
    }
  }

  // Coins after last obstacle
  if (obstacles.length > 0) {
    const lastT = obstacles[obstacles.length - 1].t + 0.005;
    const gap = 0.95 - lastT;
    if (gap >= 0.015) {
      const count = 2;
      const step = gap / (count + 1);
      for (let j = 1; j <= count; j++) {
        const ct = lastT + step * j;
        const cd = (rng() * 2 - 1) * (halfTrack - 0.5);
        coins.push({ t: ct, d: cd });
      }
    }
  }

  return coins;
}

function generateTurtle(rng, obstacles) {
  const halfTrack = TRACK_WIDTH / 2;
  const minT = SAFE_ZONE_T + 0.05;
  const maxT = 0.90;

  if (maxT <= minT) return null;

  let attempts = 0;
  while (attempts < 20) {
    const t = minT + rng() * (maxT - minT);
    let clear = true;
    for (const o of obstacles) {
      if (Math.abs(t - o.t) < 0.02) {
        clear = false;
        break;
      }
    }
    if (clear) {
      const d = (rng() * 2 - 1) * (halfTrack - 0.5);
      return { t, d };
    }
    attempts++;
  }

  const d = (rng() * 2 - 1) * (halfTrack - 0.5);
  return { t: minT + 0.02, d };
}

// Convert curve-local (t, d) to world position on the track surface
function curveLocalToWorld(t, d, yOffset) {
  const point = curve.getPointAt(t);
  const lateral = getLateral(t);
  const trackUp = getTrackUp(t);
  return point.clone()
    .add(lateral.clone().multiplyScalar(d))
    .add(trackUp.clone().multiplyScalar(TRACK_HEIGHT / 2 + (yOffset || 0)));
}

function generateLevel() {
  let rng = seededRandom(Date.now());
  obstacleData = generateObstacles(rng);
  coinData = generateCoins(rng, obstacleData);

  // Re-generate with a different seed if no coins were placed
  let retries = 0;
  while (coinData.length === 0 && retries < 5) {
    retries++;
    rng = seededRandom(Date.now() + retries);
    obstacleData = generateObstacles(rng);
    coinData = generateCoins(rng, obstacleData);
  }

  obstacleMeshes = obstacleData.map((o) => {
    const mesh = new THREE.Mesh(obstGeo, obstMat);
    mesh.position.copy(o.worldPos);

    // Orient obstacle to align with track
    const quat = new THREE.Quaternion();
    const basis = new THREE.Matrix4().makeBasis(o.lateral, o.trackUp, o.tangent);
    quat.setFromRotationMatrix(basis);
    mesh.quaternion.copy(quat);

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  });

  const coinY = 0.35; // Height above track surface
  coinMeshes = coinData.map((c) => {
    const worldPos = curveLocalToWorld(c.t, c.d, coinY);
    const mesh = new THREE.Mesh(coinGeo, coinMat);
    mesh.position.copy(worldPos);
    mesh.rotation.x = Math.PI / 2;
    scene.add(mesh);
    return mesh;
  });

  // Turtle powerup
  turtleData = generateTurtle(rng, obstacleData);
  if (turtleData) {
    turtleMesh = createTurtleMesh();
    const turtleWorldPos = curveLocalToWorld(turtleData.t, turtleData.d, 0.35);
    turtleMesh.position.copy(turtleWorldPos);
    scene.add(turtleMesh);
  }
}

export function regenerateLevel() {
  for (const mesh of obstacleMeshes) {
    scene.remove(mesh);
  }
  obstacleMeshes = [];
  obstacleData = [];

  for (const mesh of coinMeshes) {
    scene.remove(mesh);
  }
  coinMeshes = [];
  coinData = [];

  if (turtleMesh) {
    scene.remove(turtleMesh);
    turtleMesh = null;
    turtleData = null;
  }

  generateLevel();
}

export function initRenderer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 40, 120);

  // Build curve
  buildCurve();

  // Camera
  const startPoint = curve.getPointAt(0);
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(startPoint.x, startPoint.y + 4, startPoint.z - 8);
  camera.lookAt(startPoint);

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

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 20, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 100;
  dirLight.shadow.camera.left = -20;
  dirLight.shadow.camera.right = 20;
  dirLight.shadow.camera.top = 40;
  dirLight.shadow.camera.bottom = -40;
  scene.add(dirLight);

  // A second directional light for better illumination along the course
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dirLight2.position.set(-5, 15, 70);
  scene.add(dirLight2);

  // Ground plane (far below track, for visual reference)
  const groundGeo = new THREE.PlaneGeometry(300, 300);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x3a7d3a, roughness: 0.9 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -5;
  ground.receiveShadow = true;
  scene.add(ground);

  // Build track mesh
  buildTrackMesh();

  // Build finish line
  buildFinishLine();

  // Ball
  const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 32, 32);
  const ballMat = new THREE.MeshStandardMaterial({
    color: 0xff4444,
    metalness: 0.3,
    roughness: 0.4,
  });
  ballMesh = new THREE.Mesh(ballGeo, ballMat);
  ballMesh.castShadow = true;
  const ballStart = curveLocalToWorld(0, 0, BALL_RADIUS);
  ballMesh.position.copy(ballStart);
  scene.add(ballMesh);

  // Generate level
  generateLevel();

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
  ballMesh.rotation.x -= (vz / BALL_RADIUS) * dt;
  ballMesh.rotation.z += (vx / BALL_RADIUS) * dt;
}

// Camera smoothly follows the ball along the curve
const _cameraTarget = new THREE.Vector3();
const _cameraPos = new THREE.Vector3();

export function updateCamera(ballT, ballWorldPos) {
  if (!curve) return;

  const clampedT = Math.max(0, Math.min(1, ballT));
  const tangent = curve.getTangentAt(clampedT);

  // Camera positioned behind the ball along the tangent
  _cameraPos.copy(ballWorldPos)
    .sub(tangent.clone().multiplyScalar(8))
    .add(new THREE.Vector3(0, 4, 0));

  // Smooth follow
  camera.position.lerp(_cameraPos, 0.08);

  _cameraTarget.copy(ballWorldPos).add(new THREE.Vector3(0, 0.5, 0));
  camera.lookAt(_cameraTarget);
}

export function render() {
  renderer.render(scene, camera);
}

export function getTrackConfig() {
  return {
    trackWidth: TRACK_WIDTH,
    trackHeight: TRACK_HEIGHT,
    trackLength: curveLength,
    ballRadius: BALL_RADIUS,
    ballStartT: 0,
    curve,
    curveLength,
    getLateral,
    getTrackUp,
    curveLocalToWorld,
  };
}

export function getObstacles() {
  return obstacleData.map((o) => ({
    t: o.t,
    d: o.d,
    halfW: o.halfW,
    halfD: o.halfD,
    height: OBSTACLE_HEIGHT,
  }));
}

export function getCoins() {
  return coinData.map((c) => ({ t: c.t, d: c.d }));
}

export function hideCoin(index) {
  if (coinMeshes[index]) {
    coinMeshes[index].visible = false;
  }
}

export function updateCoinRotation(dt) {
  coinMeshes.forEach((m) => {
    if (m.visible) {
      m.rotation.y += 2.0 * dt;
    }
  });
  if (turtleMesh && turtleMesh.visible) {
    turtleMesh.rotation.y += 1.5 * dt;
  }
}

export function getTurtle() {
  return turtleData ? { t: turtleData.t, d: turtleData.d } : null;
}

export function hideTurtle() {
  if (turtleMesh) {
    turtleMesh.visible = false;
  }
}
