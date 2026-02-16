import * as THREE from "https://unpkg.com/three@0.161.0/build/three.module.js";

const LASER_Y = 0.36;
const CLICKABLE_TYPES = new Set(["box"]);
const INITIAL_RULES_TEXT = "Rules: Red=start, green=target, yellow diamonds=turns. Tap next box to clear path.";
const SCORE_STORAGE_KEY = "laserFlowScoreV1";
const SCORE_PER_BOX = 10;
const WIN_BONUS_BASE = 100;
const WIN_STREAK_BONUS_STEP = 50;

const canvas = document.getElementById("gameCanvas");
const statusEl = document.getElementById("status");
const resetBtn = document.getElementById("resetBtn");
const scoreLineEl = document.getElementById("scoreLine");
const scoreEl = document.getElementById("scoreValue");
const streakWrapEl = document.getElementById("streakWrap");
const highScoreWrapEl = document.getElementById("highScoreWrap");
const highScoreEl = document.getElementById("highScoreValue");
const streakEl = document.getElementById("streakValue");
const splashEl = document.getElementById("splash");
const SPLASH_DURATION_MS = 2800;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const GAME_OVER_BG = new THREE.Color(0x5f2c2c);
const GAME_WIN_BG = new THREE.Color(0x2f5f3a);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);

const pickRaycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();

const boardGroup = new THREE.Group();
scene.add(boardGroup);

const laserMaterial = new THREE.LineBasicMaterial({ color: 0xff3b3b, linewidth: 2 });
let laserLine = null;
let targetMesh = null;
let targetBaseMesh = null;
let level = null;
let audioCtx = null;
let audioUnlocked = false;

const gameState = {
  collidableMeshes: [],
  clickableMeshes: [],
  boxes: [],
  pathBoxes: [],
  trapBoxes: [],
  explosions: [],
  won: false,
  awaitingRestart: false,
  lastClearedTile: null,
  showRules: true
};

const scoreState = loadScoreState();
scoreState.score = 0;
scoreState.winStreak = 0;
saveScoreState();
updateScoreUi();
queueSplashHide();

initScene();
await loadAndBuildLevel();
startRenderLoop();

function queueSplashHide() {
  if (!splashEl) {
    return;
  }

  window.setTimeout(() => {
    splashEl.classList.add("hidden");
    window.setTimeout(() => {
      splashEl.remove();
    }, 500);
  }, SPLASH_DURATION_MS);
}

function initScene() {
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xf2f6ff, 1.0);
  key.position.set(7, 14, 7);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x4aa7ff, 0.35);
  fill.position.set(-8, 10, -6);
  scene.add(fill);

  window.addEventListener("resize", onResize);
  canvas.addEventListener("pointerdown", onPointerDown);
  resetBtn.addEventListener("click", onRestart);
}

async function loadAndBuildLevel() {
  level = await loadLevelJson();
  buildLevel(level, false);
  onResize();
  traceLaser();
}

async function loadLevelJson() {
  const fallback = {
    gridSize: 10,
    emitter: { position: [0, 0] },
    target: { position: [8, 8] },
    obstacles: []
  };

  try {
    const res = await fetch("./level1.json", { cache: "no-store" });
    if (!res.ok) {
      return fallback;
    }

    const data = await res.json();
    return {
      gridSize: data.gridSize || fallback.gridSize,
      emitter: { position: data.emitter?.position || fallback.emitter.position },
      target: { position: data.target?.position || fallback.target.position },
      obstacles: [],
      flowPath: []
    };
  } catch {
    return fallback;
  }
}

function buildLevel(levelConfig, randomizeTarget) {
  boardGroup.clear();
  gameState.collidableMeshes = [];
  gameState.clickableMeshes = [];
  gameState.boxes = [];
  gameState.pathBoxes = [];
  gameState.trapBoxes = [];
  gameState.explosions = [];
  gameState.won = false;
  gameState.awaitingRestart = false;
  updateScoreUi();
  resetBtn.hidden = true;
  resetBtn.textContent = "Restart";
  gameState.lastClearedTile = null;
  gameState.showRules = true;
  scene.background = null;

  const gridSize = levelConfig.gridSize;

  if (randomizeTarget) {
    levelConfig.target.position = randomTargetTile(levelConfig);
  }

  levelConfig.flowPath = generateFlowPath(levelConfig);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(gridSize, gridSize),
    new THREE.MeshStandardMaterial({ color: 0x19323a, metalness: 0.1, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  boardGroup.add(floor);

  const grid = new THREE.GridHelper(gridSize, gridSize, 0x60d0e6, 0x2f5560);
  grid.position.y = 0.002;
  boardGroup.add(grid);

  addBoundaryWalls(levelConfig);
  addEmitter(levelConfig.emitter.position, levelConfig.flowPath);
  addTarget(levelConfig.target.position);

  const turnTiles = getTurnTiles(levelConfig.flowPath);
  addTurnMarkers(turnTiles);

  levelConfig.obstacles = generatePathBoxes(levelConfig.flowPath, turnTiles);
  for (const obstacle of levelConfig.obstacles) {
    addBox(obstacle.position, "path");
  }

  levelConfig.traps = generateTrapBoxes(levelConfig, levelConfig.flowPath, levelConfig.obstacles, turnTiles);
  for (const trap of levelConfig.traps) {
    addBox(trap.position, "trap");
  }

  updateCameraView(gridSize);
  setStatus(INITIAL_RULES_TEXT);
}

function randomTargetTile(levelConfig) {
  const occupied = new Set([`${levelConfig.emitter.position[0]},${levelConfig.emitter.position[1]}`]);
  const choices = [];

  for (let x = 0; x < levelConfig.gridSize; x += 1) {
    for (let y = 0; y < levelConfig.gridSize; y += 1) {
      const key = `${x},${y}`;
      if (!occupied.has(key)) {
        choices.push([x, y]);
      }
    }
  }

  if (!choices.length) {
    return [...levelConfig.target.position];
  }

  return choices[Math.floor(Math.random() * choices.length)];
}

function addBoundaryWalls(levelConfig) {
  const gridSize = levelConfig.gridSize;
  const half = gridSize / 2;
  const wallHeight = 1.2;
  const wallThickness = 0.16;

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x245360,
    roughness: 0.78,
    metalness: 0.08
  });

  const walls = [
    new THREE.Mesh(new THREE.BoxGeometry(gridSize + wallThickness * 2, wallHeight, wallThickness), wallMaterial),
    new THREE.Mesh(new THREE.BoxGeometry(gridSize + wallThickness * 2, wallHeight, wallThickness), wallMaterial),
    new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, gridSize), wallMaterial),
    new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, gridSize), wallMaterial)
  ];

  walls[0].position.set(0, wallHeight / 2, -half - wallThickness / 2);
  walls[1].position.set(0, wallHeight / 2, half + wallThickness / 2);
  walls[2].position.set(-half - wallThickness / 2, wallHeight / 2, 0);
  walls[3].position.set(half + wallThickness / 2, wallHeight / 2, 0);

  for (const wall of walls) {
    wall.userData.type = "wall";
    boardGroup.add(wall);
    gameState.collidableMeshes.push(wall);
  }
}

function addEmitter(tilePos, flowPath) {
  const worldPos = gridToWorld(level.gridSize, tilePos);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.16, 22),
    new THREE.MeshStandardMaterial({ color: 0x5f1a1a, roughness: 0.8, metalness: 0.1 })
  );
  base.position.set(worldPos.x, 0.08, worldPos.z);
  boardGroup.add(base);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0xff6a6a, emissive: 0x3a0f0f, emissiveIntensity: 0.9 })
  );
  core.position.set(worldPos.x, LASER_Y, worldPos.z);
  boardGroup.add(core);

  const nextTile = flowPath && flowPath[1] ? flowPath[1] : level.target.position;
  const nextWorld = gridToWorld(level.gridSize, nextTile);
  const directionMarker = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.12, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x8e2424, roughness: 0.5, metalness: 0.2 })
  );
  directionMarker.position.set(worldPos.x, LASER_Y, worldPos.z);
  directionMarker.lookAt(new THREE.Vector3(nextWorld.x, LASER_Y, nextWorld.z));
  boardGroup.add(directionMarker);
}
function addTarget(tilePos) {
  const worldPos = gridToWorld(level.gridSize, tilePos);

  targetBaseMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.16, 22),
    new THREE.MeshStandardMaterial({ color: 0x175640, roughness: 0.8, metalness: 0.1 })
  );
  targetBaseMesh.position.set(worldPos.x, 0.08, worldPos.z);
  boardGroup.add(targetBaseMesh);

  targetMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0x7ef29a, emissive: 0x0b3821, emissiveIntensity: 0.8 })
  );
  targetMesh.position.set(worldPos.x, LASER_Y, worldPos.z);
  targetMesh.userData.type = "target";

  boardGroup.add(targetMesh);
  gameState.collidableMeshes.push(targetMesh);
}

function addBox(tilePos, boxKind = "path") {
  const worldPos = gridToWorld(level.gridSize, tilePos);
  const isTrap = boxKind === "trap";
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.56, 0.62),
    new THREE.MeshStandardMaterial({
      color: isTrap ? 0x2f2f36 : 0x5d2d2d,
      roughness: 0.85,
      metalness: 0.08,
      emissive: isTrap ? 0x4f0a0a : 0x2a0f0f,
      emissiveIntensity: isTrap ? 0.35 : 0.2
    })
  );
  box.position.set(worldPos.x, 0.28, worldPos.z);
  box.rotation.x = 0.22 + (Math.random() - 0.5) * 0.06;
  box.rotation.z = 0.22 + (Math.random() - 0.5) * 0.06;
  box.rotation.y = Math.random() * Math.PI * 2;
  box.userData.spinSpeed = isTrap ? (1.4 + Math.random() * 1.4) : (0.8 + Math.random() * 1.2);
  box.userData.pulsePhase = Math.random() * Math.PI * 2;
  box.userData.type = "box";
  box.userData.boxKind = boxKind;
  box.userData.tilePos = [tilePos[0], tilePos[1]];
  boardGroup.add(box);
  gameState.collidableMeshes.push(box);
  gameState.clickableMeshes.push(box);
  gameState.boxes.push(box);
  if (isTrap) {
    gameState.trapBoxes.push(box);
  } else {
    gameState.pathBoxes.push(box);
  }
}
function axisPathTiles(start, end, order) {
  let x = start[0];
  let y = start[1];
  const points = [[x, y]];

  for (const axis of order) {
    if (axis === "x") {
      while (x !== end[0]) {
        x += Math.sign(end[0] - x);
        points.push([x, y]);
      }
    } else {
      while (y !== end[1]) {
        y += Math.sign(end[1] - y);
        points.push([x, y]);
      }
    }
  }

  return points;
}

function randomRouteTile(levelConfig, blocked) {
  const choices = [];
  for (let x = 0; x < levelConfig.gridSize; x += 1) {
    for (let y = 0; y < levelConfig.gridSize; y += 1) {
      const key = `${x},${y}`;
      if (!blocked.has(key)) {
        choices.push([x, y]);
      }
    }
  }

  if (!choices.length) {
    return null;
  }

  return choices[Math.floor(Math.random() * choices.length)];
}

function generateFlowPath(levelConfig) {
  const start = levelConfig.emitter.position;
  const end = levelConfig.target.position;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const waypointCount = 2 + Math.floor(Math.random() * 2);
    const blocked = new Set([`${start[0]},${start[1]}`, `${end[0]},${end[1]}`]);
    const waypoints = [];

    for (let i = 0; i < waypointCount; i += 1) {
      const point = randomRouteTile(levelConfig, blocked);
      if (!point) {
        break;
      }
      blocked.add(`${point[0]},${point[1]}`);
      waypoints.push(point);
    }

    const checkpoints = [start, ...waypoints, end];
    const used = new Set();
    const path = [];
    let valid = true;

    for (let i = 0; i < checkpoints.length - 1; i += 1) {
      const order = Math.random() < 0.5 ? ["x", "y"] : ["y", "x"];
      const seg = axisPathTiles(checkpoints[i], checkpoints[i + 1], order);

      for (let j = 0; j < seg.length; j += 1) {
        if (i > 0 && j === 0) {
          continue;
        }

        const tile = seg[j];
        const key = `${tile[0]},${tile[1]}`;
        if (used.has(key)) {
          valid = false;
          break;
        }

        used.add(key);
        path.push(tile);
      }

      if (!valid) {
        break;
      }
    }

    if (!valid || path.length < 6) {
      continue;
    }

    const last = path[path.length - 1];
    if (last[0] === end[0] && last[1] === end[1]) {
      return path;
    }
  }

  return axisPathTiles(start, end, ["x", "y"]);
}

function getTurnTiles(flowPath) {
  const turns = [];
  for (let i = 1; i < flowPath.length - 1; i += 1) {
    const prev = flowPath[i - 1];
    const curr = flowPath[i];
    const next = flowPath[i + 1];

    const dx1 = curr[0] - prev[0];
    const dy1 = curr[1] - prev[1];
    const dx2 = next[0] - curr[0];
    const dy2 = next[1] - curr[1];

    if (dx1 !== dx2 || dy1 !== dy2) {
      turns.push([curr[0], curr[1]]);
    }
  }
  return turns;
}

function addTurnMarkers(turnTiles) {
  for (const tile of turnTiles) {
    const worldPos = gridToWorld(level.gridSize, tile);
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 0.03, 0.26),
      new THREE.MeshStandardMaterial({
        color: 0xfad66a,
        emissive: 0x4b3f08,
        emissiveIntensity: 0.85,
        roughness: 0.35,
        metalness: 0.25
      })
    );
    marker.rotation.y = Math.PI / 4;
    marker.position.set(worldPos.x, 0.03, worldPos.z);
    boardGroup.add(marker);
  }
}

function generatePathBoxes(flowPath, turnTiles = []) {
  const turnSet = new Set(turnTiles.map((t) => String(t[0]) + "," + String(t[1])));
  const candidates = flowPath.slice(1, -1).filter((tile) => !turnSet.has(String(tile[0]) + "," + String(tile[1])));
  if (!candidates.length) {
    return [];
  }

  shuffleArray(candidates);

  const desired = Math.min(5, Math.max(2, Math.floor(candidates.length / 3)));
  const selected = [];

  for (const tile of candidates) {
    if (selected.length >= desired) {
      break;
    }

    let tooClose = false;
    for (const picked of selected) {
      const d = Math.abs(tile[0] - picked[0]) + Math.abs(tile[1] - picked[1]);
      if (d < 2) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose) {
      selected.push(tile);
    }
  }

  if (!selected.length) {
    selected.push(candidates[0]);
  }

  return selected.map((tile) => ({ position: [tile[0], tile[1]] }));
}

function generateTrapBoxes(levelConfig, flowPath, pathBoxes, turnTiles) {
  const blocked = new Set();
  blocked.add(`${levelConfig.emitter.position[0]},${levelConfig.emitter.position[1]}`);
  blocked.add(`${levelConfig.target.position[0]},${levelConfig.target.position[1]}`);

  for (const tile of flowPath || []) {
    blocked.add(`${tile[0]},${tile[1]}`);
  }
  for (const tile of turnTiles || []) {
    blocked.add(`${tile[0]},${tile[1]}`);
  }
  for (const box of pathBoxes || []) {
    blocked.add(`${box.position[0]},${box.position[1]}`);
  }

  const candidates = [];
  for (let x = 0; x < levelConfig.gridSize; x += 1) {
    for (let y = 0; y < levelConfig.gridSize; y += 1) {
      const key = `${x},${y}`;
      if (!blocked.has(key)) {
        candidates.push([x, y]);
      }
    }
  }

  if (!candidates.length) {
    return [];
  }

  shuffleArray(candidates);
  const desired = Math.min(4, Math.max(2, Math.floor((levelConfig.gridSize - 2) / 3)));
  const selected = [];

  for (const tile of candidates) {
    if (selected.length >= desired) {
      break;
    }

    let tooClose = false;
    for (const picked of selected) {
      const d = Math.abs(tile[0] - picked[0]) + Math.abs(tile[1] - picked[1]);
      if (d < 2) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose) {
      selected.push(tile);
    }
  }

  if (!selected.length) {
    selected.push(candidates[0]);
  }

  return selected.map((tile) => ({ position: [tile[0], tile[1]] }));
}

function ensureAudioUnlocked() {
  if (audioUnlocked) {
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    return;
  }

  if (!audioCtx) {
    audioCtx = new AudioCtx();
  }

  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  audioUnlocked = true;
}

function playTone(freq, startAt, duration, gainValue, type = "sine") {
  if (!audioCtx) {
    return;
  }

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);

  const attack = Math.min(0.02, duration * 0.25);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(gainValue, startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

function playCorrectBoxSound() {
  if (!audioCtx) {
    return;
  }

  const t = audioCtx.currentTime + 0.01;
  playTone(740, t, 0.08, 0.05, "triangle");
  playTone(988, t + 0.09, 0.11, 0.05, "triangle");
}

function playGameOverSound() {
  if (!audioCtx) {
    return;
  }

  const t = audioCtx.currentTime + 0.01;
  playTone(260, t, 0.14, 0.08, "sawtooth");
  playTone(196, t + 0.11, 0.2, 0.08, "sawtooth");
}

function playWinSound() {
  if (!audioCtx) {
    return;
  }

  const t = audioCtx.currentTime + 0.01;
  playTone(523.25, t, 0.12, 0.06, "triangle");
  playTone(659.25, t + 0.12, 0.12, 0.06, "triangle");
  playTone(783.99, t + 0.24, 0.12, 0.06, "triangle");
  playTone(1046.5, t + 0.36, 0.2, 0.07, "triangle");
}

function onPointerDown(event) {
  ensureAudioUnlocked();
  if (gameState.awaitingRestart) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  pickRaycaster.setFromCamera(mouseNdc, camera);
  const hits = pickRaycaster.intersectObjects(gameState.clickableMeshes, false);
  if (!hits.length) {
    return;
  }

  const obj = hits[0].object;
  if (!CLICKABLE_TYPES.has(obj.userData.type)) {
    return;
  }

  if (obj.userData.boxKind === "trap") {
    explodeAndRemoveBox(obj);
    gameState.won = false;
    gameState.awaitingRestart = true;
    scene.background = GAME_OVER_BG;
    resetBtn.textContent = "Restart";
    resetBtn.hidden = false;
    handleGameOver();
    playGameOverSound();
    setStatus("GAME OVER. Wrong box.", false, true);
    return;
  }

  const nextTile = getNextPathBoxTile();
  const tile = obj.userData.tilePos;
  const isNext = nextTile && tile[0] === nextTile[0] && tile[1] === nextTile[1];

  if (!isNext) {
    explodeAndRemoveBox(obj);
    gameState.won = false;
    gameState.awaitingRestart = true;
    scene.background = GAME_OVER_BG;
    resetBtn.textContent = "Restart";
    resetBtn.hidden = false;
    handleGameOver();
    playGameOverSound();
    setStatus("GAME OVER. Wrong box.", false, true);
    return;
  }

  gameState.lastClearedTile = [tile[0], tile[1]];
  gameState.showRules = false;
  addScore(SCORE_PER_BOX);
  playCorrectBoxSound();
  explodeAndRemoveBox(obj);
  traceLaser();
}
function explodeAndRemoveBox(boxMesh) {
  boardGroup.remove(boxMesh);
  boxMesh.geometry.dispose();
  boxMesh.material.dispose();

  gameState.collidableMeshes = gameState.collidableMeshes.filter((mesh) => mesh !== boxMesh);
  gameState.clickableMeshes = gameState.clickableMeshes.filter((mesh) => mesh !== boxMesh);
  gameState.boxes = gameState.boxes.filter((mesh) => mesh !== boxMesh);
  gameState.pathBoxes = gameState.pathBoxes.filter((mesh) => mesh !== boxMesh);
  gameState.trapBoxes = gameState.trapBoxes.filter((mesh) => mesh !== boxMesh);

  const blast = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffb15c, transparent: true, opacity: 0.95 })
  );
  blast.position.copy(boxMesh.position);
  blast.position.y = LASER_Y;
  boardGroup.add(blast);

  gameState.explosions.push({ mesh: blast, age: 0, lifetime: 0.25 });
}

function onRestart() {
  if (gameState.won) {
    scoreState.score = 0;
    saveScoreState();
    updateScoreUi();
  }

  buildLevel(level, true);
  traceLaser();
}

function tileToPoint(tile) {
  const world = gridToWorld(level.gridSize, tile);
  return new THREE.Vector3(world.x, LASER_Y, world.z);
}

function getPathBoxTileSet() {
  const set = new Set();
  for (const box of gameState.pathBoxes) {
    const tile = box.userData.tilePos;
    set.add(`${tile[0]},${tile[1]}`);
  }
  return set;
}

function getNextPathBoxTile() {
  const remaining = getPathBoxTileSet();
  const flowPath = level.flowPath || [];
  for (let i = 1; i < flowPath.length; i += 1) {
    const tile = flowPath[i];
    const key = `${tile[0]},${tile[1]}`;
    if (remaining.has(key)) {
      return tile;
    }
  }
  return null;
}
function traceLaser() {
  scene.updateMatrixWorld(true);

  const flowPath = level.flowPath || [];
  const hitTarget = gameState.pathBoxes.length === 0;
  const points = [tileToPoint(level.emitter.position)];
  const lastCleared = gameState.lastClearedTile;

  if (hitTarget) {
    for (let i = 1; i < flowPath.length; i += 1) {
      points.push(tileToPoint(flowPath[i]));
    }
  } else if (lastCleared) {
    for (let i = 1; i < flowPath.length; i += 1) {
      const tile = flowPath[i];
      points.push(tileToPoint(tile));

      if (tile[0] === lastCleared[0] && tile[1] === lastCleared[1]) {
        break;
      }
    }
  }

  drawLaser(points);

  if (hitTarget && !gameState.awaitingRestart) {
    gameState.won = true;
    gameState.awaitingRestart = true;
    scene.background = GAME_WIN_BG;
    resetBtn.textContent = "New Game";
    resetBtn.hidden = false;
    playWinSound();
    setStatus(handleWin(), true);
    return;
  }

  if (!gameState.awaitingRestart) {
    gameState.won = false;
    setStatus(gameState.showRules ? INITIAL_RULES_TEXT : "");
  }
}
function drawLaser(points) {
  if (laserLine) {
    scene.remove(laserLine);
    laserLine.geometry.dispose();
  }

  const geom = new THREE.BufferGeometry().setFromPoints(points);
  laserLine = new THREE.Line(geom, laserMaterial);
  scene.add(laserLine);
}

function shuffleArray(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = items[i];
    items[i] = items[j];
    items[j] = temp;
  }
}

function gridToWorld(gridSize, tilePos) {
  const half = gridSize / 2;
  return {
    x: -half + 0.5 + tilePos[0],
    z: -half + 0.5 + tilePos[1]
  };
}

function sanitizeNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
}

function loadScoreState() {
  const fallback = { score: 0, highScore: 0, winStreak: 0 };
  try {
    const raw = localStorage.getItem(SCORE_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }

    const data = JSON.parse(raw);
    return {
      score: sanitizeNonNegativeInt(data.score),
      highScore: sanitizeNonNegativeInt(data.highScore),
      winStreak: sanitizeNonNegativeInt(data.winStreak)
    };
  } catch {
    return fallback;
  }
}

function saveScoreState() {
  localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(scoreState));
}

function updateScoreUi() {
  if (scoreLineEl) {
    scoreLineEl.hidden = gameState.awaitingRestart && !gameState.won;
  }

  if (scoreEl) {
    scoreEl.textContent = String(scoreState.score);
  }
  if (streakEl) {
    streakEl.textContent = String(scoreState.winStreak);
  }
  if (highScoreEl) {
    highScoreEl.textContent = String(scoreState.highScore);
  }

  const showWinStats = gameState.won;
  if (streakWrapEl) {
    streakWrapEl.hidden = !showWinStats;
  }
  if (highScoreWrapEl) {
    highScoreWrapEl.hidden = !showWinStats;
  }
}

function addScore(points) {
  const gain = sanitizeNonNegativeInt(points);
  if (!gain) {
    return;
  }

  scoreState.score += gain;
  saveScoreState();
  updateScoreUi();
}

function handleGameOver() {
  scoreState.winStreak = 0;
  saveScoreState();
  updateScoreUi();
}

function handleWin() {
  scoreState.winStreak += 1;
  const winBonus = WIN_BONUS_BASE + (scoreState.winStreak - 1) * WIN_STREAK_BONUS_STEP;
  addScore(winBonus);

  let isNewHigh = false;
  if (scoreState.score > scoreState.highScore) {
    scoreState.highScore = scoreState.score;
    isNewHigh = true;
    saveScoreState();
    updateScoreUi();
  }

  if (isNewHigh) {
    return "YOU WIN! Target reached. +" + String(winBonus) + " NEW HIGH SCORE!";
  }
  return "YOU WIN! Target reached. +" + String(winBonus);
}

function setStatus(text, success = false, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("success", success);
  statusEl.classList.toggle("error", error);
}

function updateCameraView(gridSize) {
  const width = Math.max(canvas.clientWidth || window.innerWidth, 1);
  const height = Math.max(canvas.clientHeight || window.innerHeight, 1);
  const aspect = width / height;
  const isLandscape = width > height;
  let landscapeScale = 1;
  let landscapeDownOffset = 0;

  if (isLandscape && width >= 768) {
    landscapeScale = 1.25;
    landscapeDownOffset = 0.38;
  }

  if (isLandscape && width >= 1200) {
    landscapeScale = 1.35;
    landscapeDownOffset = 0.5;
  }

  const baseHalf = (gridSize / 2 + 1.2) * landscapeScale;
  const half = baseHalf / Math.min(1, aspect);

  camera.left = -half * aspect;
  camera.right = half * aspect;
  camera.top = half + landscapeDownOffset;
  camera.bottom = -half + landscapeDownOffset;
  camera.position.set(0, gridSize * 2.2, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

function onResize() {
  const width = Math.max(canvas.clientWidth || window.innerWidth, 1);
  const height = Math.max(canvas.clientHeight || window.innerHeight, 1);
  renderer.setSize(width, height, false);
  updateCameraView(level ? level.gridSize : 10);
}

function updateBoxesAnimation(time) {
  if (gameState.awaitingRestart && !gameState.won) {
    return;
  }
  for (const box of gameState.boxes) {
    if (!box.material) {
      continue;
    }

    const spinSpeed = box.userData.spinSpeed || 1;
    const phase = box.userData.pulsePhase || 0;

    box.rotation.y += 0.018 * spinSpeed;
    box.position.y = 0.28 + Math.sin(time * 3 + phase) * 0.02;
    box.material.emissiveIntensity = 0.28 + 0.18 * (0.5 + 0.5 * Math.sin(time * 5 + phase));
  }
}
function updateExplosions(delta) {
  for (let i = gameState.explosions.length - 1; i >= 0; i -= 1) {
    const item = gameState.explosions[i];
    item.age += delta;

    const p = Math.min(item.age / item.lifetime, 1);
    item.mesh.scale.setScalar(1 + p * 2.8);
    item.mesh.material.opacity = 1 - p;

    if (p >= 1) {
      boardGroup.remove(item.mesh);
      item.mesh.geometry.dispose();
      item.mesh.material.dispose();
      gameState.explosions.splice(i, 1);
    }
  }
}

function startRenderLoop() {
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    const t = clock.elapsedTime;

    if (targetMesh) {
      targetMesh.scale.setScalar(1 + Math.sin(t * 3.2) * 0.05);
      targetMesh.material.emissiveIntensity = gameState.won ? 1.2 : 0.7;
    }

    updateBoxesAnimation(t);
    updateExplosions(delta);
    renderer.render(scene, camera);
  });
}
