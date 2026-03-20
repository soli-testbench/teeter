import * as THREE from 'three';

const TRACK_WIDTH = 3;
const TRACK_HEIGHT = 0.2;
const TRACK_LENGTH = 50;
const BALL_RADIUS = 0.3;
const BALL_START_Z = -20;

let scene, camera, renderer;
let trackGroup, trackMesh, ballMesh;
let edgeLeft, edgeRight;

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

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 5);
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

  // Track group (for tilt rotation)
  trackGroup = new THREE.Group();
  scene.add(trackGroup);

  // Track
  const trackGeo = new THREE.BoxGeometry(TRACK_WIDTH, TRACK_HEIGHT, TRACK_LENGTH);
  const trackMat = new THREE.MeshStandardMaterial({
    color: 0x8B7355,
    roughness: 0.7,
    metalness: 0.1,
  });
  trackMesh = new THREE.Mesh(trackGeo, trackMat);
  trackMesh.position.set(0, 0, 0);
  trackMesh.receiveShadow = true;
  trackGroup.add(trackMesh);

  // Edge lines for visibility
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.6 });
  const edgeGeo = new THREE.BoxGeometry(0.06, 0.08, TRACK_LENGTH);
  edgeLeft = new THREE.Mesh(edgeGeo, edgeMat);
  edgeLeft.position.set(-TRACK_WIDTH / 2, TRACK_HEIGHT / 2 + 0.04, 0);
  trackGroup.add(edgeLeft);

  edgeRight = new THREE.Mesh(edgeGeo, edgeMat);
  edgeRight.position.set(TRACK_WIDTH / 2, TRACK_HEIGHT / 2 + 0.04, 0);
  trackGroup.add(edgeRight);

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

export function updateTrackTilt(tiltAngle) {
  // Subtle visual tilt of the track, clamped
  const maxVisualTilt = 0.15;
  trackGroup.rotation.z = Math.max(-maxVisualTilt, Math.min(maxVisualTilt, tiltAngle * 0.5));
}

export function updateCamera(ballZ) {
  camera.position.z = ballZ - 8;
  camera.position.y = 4;
  camera.lookAt(0, 0, ballZ);
}

export function render() {
  renderer.render(scene, camera);
}

export function getTrackConfig() {
  return {
    trackWidth: TRACK_WIDTH,
    trackHeight: TRACK_HEIGHT,
    trackLength: TRACK_LENGTH,
    ballRadius: BALL_RADIUS,
    ballStartZ: BALL_START_Z,
  };
}
