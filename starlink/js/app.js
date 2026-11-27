import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEarth, createStarfield } from './earth.js';
import { loadElements, formatAge, REFRESH_INTERVAL_MS, SOURCE_LABELS } from './data.js';
import {
  GROUPS, MU_SCENE, classifyAll, gmst, sunDirectionEci, surfaceVector,
} from './astro.js';

const $ = (id) => document.getElementById(id);
const fmtInt = new Intl.NumberFormat('en-US');
const fmt1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LIVE_TICK_MS = 500; // SGP4 refresh rate in real time; the GPU extrapolates in between
const WARP_TICK_MS = 100;
const TRACK_REFRESH_SIM_MS = 30_000;
const DISH_MIN_ELEVATION = 25; // Starlink dishes talk to satellites at least 25° above the horizon
const MAX_BEAMS = 256;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------------------------
// Renderer, camera, scene
// ---------------------------------------------------------------------------------------------

const canvas = $('globe');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  showFatal('Your browser could not start WebGL, which this 3D globe needs. Try another browser or enable hardware acceleration.');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x03050b, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = 12;
controls.zoomSpeed = 0.8;

// Start looking at the viewer's part of the world (guessed from their time zone).
{
  const lonGuess = THREE.MathUtils.clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
  const [x, y, z] = surfaceVector(22, lonGuess, 3.6);
  camera.position.set(x, y, z);
}

const earth = createEarth(renderer);
scene.add(earth.group);

// Everything in this group is expressed in the inertial frame; rotating the group by -GMST each
// frame keeps the Earth itself fixed in the scene, so the camera stays over the same region.
const inertial = new THREE.Group();
scene.add(inertial);
inertial.add(createStarfield());

// ---------------------------------------------------------------------------------------------
// Satellites: one point per satellite. Positions come from SGP4 a couple of times a second and
// the vertex shader carries each one along its (near-circular) orbit in between.
// ---------------------------------------------------------------------------------------------

const satUniforms = {
  uDt: { value: 0 },
  uSun: { value: new THREE.Vector3(1, 0, 0) },
  uSize: { value: 3.0 },
  uPixelRatio: { value: renderer.getPixelRatio() },
  uMu: { value: MU_SCENE },
};

const satMaterial = new THREE.ShaderMaterial({
  uniforms: satUniforms,
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    uniform float uDt;
    uniform vec3 uSun;
    uniform float uSize;
    uniform float uPixelRatio;
    uniform float uMu;
    attribute vec3 aVelocity;
    attribute vec3 aColor;
    attribute float aVisible;
    varying vec3 vColor;
    varying float vLit;
    void main() {
      // Rotate the state vector through the elapsed angle of a circular orbit.
      float r = length(position);
      float n = sqrt(uMu / (r * r * r));
      float a = n * uDt;
      vec3 p = position * cos(a) + aVelocity * (sin(a) / n);
      // Inside Earth's cylindrical shadow?
      float along = dot(p, uSun);
      float off = length(p - along * uSun);
      vLit = along > 0.0 ? 1.0 : smoothstep(0.99, 1.01, off);
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float attenuation = clamp(3.4 / -mv.z, 0.6, 2.6);
      gl_PointSize = aVisible * uSize * uPixelRatio * attenuation;
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vLit;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d2 = dot(c, c);
      if (d2 > 0.25) discard;
      float edge = 1.0 - smoothstep(0.12, 0.25, d2);
      vec3 shadow = vColor * 0.38 + vec3(0.03, 0.04, 0.06);
      vec3 lit = min(vColor * 1.12 + 0.10, vec3(1.0));
      gl_FragColor = vec4(mix(shadow, lit, vLit), edge * mix(0.6, 1.0, vLit));
    }`,
});

let satPoints = null;

/** Static facts about each satellite, from the worker's `ready` message. */
let meta = null;
/** Latest propagated state from the worker. */
let state = null;
let groupVisible = GROUPS.map(() => true);
let visibleMask = null; // Uint8Array: ok && group shown

function buildSatellites() {
  if (satPoints) {
    inertial.remove(satPoints);
    satPoints.geometry.dispose();
  }
  const n = meta.count;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geometry.setAttribute('aVelocity', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const colors = new Float32Array(n * 3);
  const palette = GROUPS.map((g) => hexToRgb(g.color));
  for (let i = 0; i < n; i++) colors.set(palette[meta.group[i]], i * 3);
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aVisible', new THREE.BufferAttribute(new Float32Array(n), 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
  satPoints = new THREE.Points(geometry, satMaterial);
  satPoints.frustumCulled = false;
  satPoints.visible = false; // until the first state arrives
  inertial.add(satPoints);
  visibleMask = new Uint8Array(n);
}

function refreshVisibility() {
  if (!satPoints || !state) return;
  const attr = satPoints.geometry.getAttribute('aVisible');
  for (let i = 0; i < meta.count; i++) {
    const v = state.ok[i] && groupVisible[meta.group[i]] ? 1 : 0;
    visibleMask[i] = v;
    attr.array[i] = v;
  }
  attr.needsUpdate = true;
}

/** Extrapolated inertial position (scene units) of satellite i at `simTime`. */
function satLocalPosition(i, simTime, out) {
  const k = i * 3;
  const p = state.pos;
  const v = state.vel;
  const dt = (simTime - state.time) / 1000;
  const r = Math.hypot(p[k], p[k + 1], p[k + 2]);
  const n = Math.sqrt(MU_SCENE / (r * r * r));
  const c = Math.cos(n * dt);
  const s = Math.sin(n * dt) / n;
  return out.set(p[k] * c + v[k] * s, p[k + 1] * c + v[k + 1] * s, p[k + 2] * c + v[k + 2] * s);
}

// ---------------------------------------------------------------------------------------------
// Selection, hover, orbit + ground track, observer beams
// ---------------------------------------------------------------------------------------------

const ringTexture = makeRingTexture();
const selectMarker = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: ringTexture, color: 0xffffff, sizeAttenuation: false, depthWrite: false, transparent: true }),
);
selectMarker.scale.setScalar(0.03);
selectMarker.visible = false;
selectMarker.renderOrder = 3;
inertial.add(selectMarker);

const hoverMarker = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: ringTexture, color: 0xffffff, opacity: 0.7, sizeAttenuation: false, depthWrite: false, transparent: true }),
);
hoverMarker.scale.setScalar(0.022);
hoverMarker.visible = false;
hoverMarker.renderOrder = 3;
inertial.add(hoverMarker);

const orbitLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }),
);
orbitLine.frustumCulled = false;
orbitLine.visible = false;
inertial.add(orbitLine);

const groundLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }),
);
groundLine.frustumCulled = false;
groundLine.visible = false;
earth.group.add(groundLine);

const observerMarker = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: makePinTexture(), sizeAttenuation: false, depthWrite: false, transparent: true }),
);
observerMarker.scale.setScalar(0.03);
observerMarker.center.set(0.5, 0.1);
observerMarker.visible = false;
observerMarker.renderOrder = 4;
earth.group.add(observerMarker);

const beamPositions = new Float32Array(MAX_BEAMS * 2 * 3);
const beamGeometry = new THREE.BufferGeometry();
beamGeometry.setAttribute('position', new THREE.BufferAttribute(beamPositions, 3));
const beams = new THREE.LineSegments(
  beamGeometry,
  new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.35, depthWrite: false }),
);
beams.frustumCulled = false;
beams.visible = false;
inertial.add(beams);

let selected = -1;
let hovered = -1;
let following = false;
let flight = null;
let trackTime = -Infinity;
let trackInFlight = false;
let lastTrackPerf = 0;
let observer = null; // {lat, lon, world: Vector3}
let lastSelectedInfo = null;

// ---------------------------------------------------------------------------------------------
// Simulation clock
// ---------------------------------------------------------------------------------------------

const clock = {
  base: Date.now(),
  perf: performance.now(),
  rate: 1,
  paused: false,
  now() {
    return this.paused ? this.base : this.base + (performance.now() - this.perf) * this.rate;
  },
  rebase() {
    this.base = this.now();
    this.perf = performance.now();
  },
  setRate(rate) {
    this.rebase();
    this.rate = rate;
    this.paused = false;
  },
  togglePause() {
    this.rebase();
    this.paused = !this.paused;
  },
  goLive() {
    this.base = Date.now();
    this.perf = performance.now();
    this.rate = 1;
    this.paused = false;
  },
  isLive() {
    return !this.paused && this.rate === 1 && Math.abs(this.now() - Date.now()) < 5000;
  },
};

// ---------------------------------------------------------------------------------------------
// Orbit calculator: a web worker, or the page itself if the browser won't start one
// ---------------------------------------------------------------------------------------------

let workerReady = false;
let tickInFlight = false;
let lastTickPerf = -Infinity;
let forceTick = false;
let dataset = null; // {fetchedAt, source, stale}
let firstState = true;
let pendingSelectNorad = readHashNorad();
let lastInitMsg = null; // re-sent if we have to fall back to the page
let lastObserverMsg = null;
let usingPageFallback = false;
let propagator = startWorker();
if (!propagator) fallBackToPage();

function startWorker() {
  try {
    // A single-file build embeds the worker's code in the page instead of shipping it as a file.
    const inline = document.getElementById('propagator-source');
    const url = inline
      ? URL.createObjectURL(new Blob([inline.textContent], { type: 'text/javascript' }))
      : new URL('./propagator.worker.js', import.meta.url);
    const w = new Worker(url, { type: 'module' });
    w.onmessage = ({ data }) => onPropagatorMessage(data);
    w.onerror = (event) => {
      console.warn('Orbit worker failed; computing on the page instead.', event.message || event);
      w.terminate();
      fallBackToPage();
    };
    return w;
  } catch (err) {
    console.warn('Orbit worker unavailable; computing on the page instead.', err);
    return null;
  }
}

async function fallBackToPage() {
  if (usingPageFallback) return;
  usingPageFallback = true;
  propagator = null;
  tickInFlight = false;
  trackInFlight = false;
  try {
    const { createPropagator } = await import('./propagator.js');
    const local = createPropagator((msg) => onPropagatorMessage(msg));
    propagator = { postMessage: (msg) => setTimeout(() => local.handle(msg), 0) };
    if (lastInitMsg) propagator.postMessage(lastInitMsg);
    if (lastObserverMsg) propagator.postMessage(lastObserverMsg);
  } catch (err) {
    console.error(err);
    showFatal("The orbit calculator couldn't load. Check your connection (it loads from cdn.jsdelivr.net) and reload.");
  }
}

function send(msg) {
  if (msg.type === 'init') lastInitMsg = msg;
  if (msg.type === 'observer') lastObserverMsg = msg;
  propagator?.postMessage(msg);
}

function onPropagatorMessage(msg) {
  if (msg.type === 'ready') onWorkerReady(msg);
  else if (msg.type === 'state') onState(msg);
  else if (msg.type === 'track') onTrack(msg);
  else if (msg.type === 'error') {
    console.error('Worker error:', msg.message);
    if (msg.request === 'tick') tickInFlight = false;
    if (msg.request === 'track') trackInFlight = false;
    if (msg.request === 'init') showFatal(`Couldn't read the orbital elements: ${msg.message}`);
  }
}

function onWorkerReady(msg) {
  const previousNorad = selected >= 0 && meta ? meta.norad[selected] : null;
  const { group, shell, shells } = classifyAll(msg.inclination, msg.meanAltitude);
  meta = { ...msg, group, shell, shells, searchNames: msg.names.map((s) => s.toUpperCase()) };
  state = null;
  workerReady = true;
  tickInFlight = false;
  forceTick = true;
  buildSatellites();
  buildLegend();
  $('search').disabled = false;
  $('btn-locate').disabled = false;
  setLoader(`Positioning ${fmtInt.format(msg.usable)} satellites…`);

  // Keep (or restore from the URL) the selection across data loads; indices change between loads.
  const norad = pendingSelectNorad ?? previousNorad;
  pendingSelectNorad = null;
  selected = -1;
  lastSelectedInfo = null;
  if (norad == null) return;
  const idx = meta.norad.indexOf(norad);
  if (idx < 0) {
    if (previousNorad != null) deselect();
    toast(`Satellite ${norad} isn't in the current Starlink data.`);
  } else if (firstState) {
    selected = idx; // opened with #sat-…: selected and flown to once positions arrive
  } else {
    select(idx, { fly: false });
  }
}

function onState(msg) {
  tickInFlight = false;
  if (!meta || msg.pos.length !== meta.count * 3) return; // stale reply from before a data refresh
  state = msg;
  const geometry = satPoints.geometry;
  geometry.getAttribute('position').array.set(msg.pos);
  geometry.getAttribute('position').needsUpdate = true;
  geometry.getAttribute('aVelocity').array.set(msg.vel);
  geometry.getAttribute('aVelocity').needsUpdate = true;
  refreshVisibility();
  satPoints.visible = true;

  updateStats(msg.stats);
  updateLegendCounts();
  if (selected >= 0) {
    if (!state.ok[selected]) {
      toast(`${meta.names[selected]} has no valid position right now.`);
      deselect();
    } else if (msg.selected) {
      lastSelectedInfo = msg.selected;
      updateInfo(msg.selected);
    }
  }
  updateObserverStats();

  if (firstState) {
    firstState = false;
    hideLoader();
    if (selected >= 0) select(selected, { fly: true });
  }
}

function onTrack(msg) {
  trackInFlight = false;
  if (msg.index !== selected || !msg.points) return;
  setLine(orbitLine, msg.orbit, msg.points);
  setLine(groundLine, msg.ground, msg.points);
  groundLine.material.color.set(GROUPS[meta.group[selected]].color);
  orbitLine.visible = true;
  groundLine.visible = true;
  trackTime = msg.time;
}

function setLine(line, positions, count) {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry();
  line.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  line.geometry.setDrawRange(0, count);
}

function maybeTick(perfNow, simNow) {
  if (!workerReady || tickInFlight) return;
  const interval = clock.paused ? Infinity : clock.rate === 1 ? LIVE_TICK_MS : WARP_TICK_MS;
  if (!forceTick && perfNow - lastTickPerf < interval) return;
  forceTick = false;
  tickInFlight = true;
  lastTickPerf = perfNow;
  send({ type: 'tick', time: simNow, selected });
}

function maybeTrack(perfNow, simNow) {
  if (selected < 0 || trackInFlight || !workerReady) return;
  if (Math.abs(simNow - trackTime) < TRACK_REFRESH_SIM_MS || perfNow - lastTrackPerf < 250) return;
  trackInFlight = true;
  lastTrackPerf = perfNow;
  send({ type: 'track', index: selected, time: simNow });
}

// ---------------------------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------------------------

async function loadData({ initial = false } = {}) {
  try {
    if (initial) setLoader('Loading orbital elements…');
    const result = await loadElements({ have: initial ? null : dataset });
    if (!result || (!initial && dataset && result.fetchedAt <= dataset.fetchedAt)) {
      updateDataAge(); // nothing newer yet
      return;
    }
    dataset = { fetchedAt: result.fetchedAt, source: result.source, stale: result.stale };
    if (result.warning) toast(result.warning);
    else if (initial && Date.now() - result.fetchedAt > OLD_DATA_MS) {
      toast(`These orbital elements are ${formatAge(Date.now() - result.fetchedAt)} old, so positions are approximate.`);
    }
    if (initial) setLoader(`Computing orbits for ${fmtInt.format(result.rows.length)} satellites…`);
    send({ type: 'init', rows: result.rows });
    updateDataAge();
  } catch (err) {
    console.error(err);
    if (initial) {
      showFatal(`Couldn't load Starlink orbital data: ${err.message}.`, true);
    } else {
      toast(`Couldn't refresh orbital elements: ${err.message}.`);
    }
  }
}

setInterval(() => {
  if (dataset && Date.now() - dataset.fetchedAt >= REFRESH_INTERVAL_MS) loadData();
  updateDataAge();
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------------------------

function updateStats(stats) {
  $('stat-count').textContent = fmtInt.format(stats.live);
  const pct = stats.live ? Math.round((stats.sunlit / stats.live) * 100) : 0;
  $('stat-sunlit').textContent = `${fmtInt.format(stats.sunlit)} (${pct}%)`;
  $('stat-shadow').textContent = `${fmtInt.format(stats.live - stats.sunlit)} (${100 - pct}%)`;
  $('stat-alt').textContent = Number.isFinite(stats.meanAltitude) ? `${fmtInt.format(Math.round(stats.meanAltitude))} km` : '—';
}

const OLD_DATA_MS = 6 * 60 * 60 * 1000;

function updateDataAge() {
  if (!dataset) return;
  const label = SOURCE_LABELS[dataset.source] || dataset.source;
  const age = Date.now() - dataset.fetchedAt;
  $('stat-data').textContent = `${formatAge(age)} ago`;
  $('stat-data').title = `Source: ${label}${dataset.stale ? ' (could not refresh)' : ''}`;
  const note = $('data-note');
  note.hidden = age < OLD_DATA_MS;
  note.textContent = `These orbital elements are ${formatAge(age)} old. Positions drift further from reality as they age.`;
}

const legendButtons = [];
const legendCounts = [];

function buildLegend() {
  const list = $('legend-list');
  list.replaceChildren();
  legendButtons.length = 0;
  legendCounts.length = 0;
  GROUPS.forEach((g, gi) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'legend-item';
    btn.setAttribute('aria-pressed', String(groupVisible[gi]));
    btn.title = `Show or hide ${g.label}`;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.setProperty('--c', g.color);
    const label = document.createElement('span');
    label.className = 'legend-label';
    label.textContent = g.label;
    const count = document.createElement('span');
    count.className = 'legend-count';
    count.textContent = '—';
    const detail = document.createElement('span');
    detail.className = 'legend-detail';
    detail.textContent = legendDetail(gi);
    btn.append(swatch, label, count, detail);
    btn.addEventListener('click', () => {
      groupVisible[gi] = !groupVisible[gi];
      btn.setAttribute('aria-pressed', String(groupVisible[gi]));
      refreshVisibility();
      if (hovered >= 0 && !visibleMask[hovered]) setHover(-1);
    });
    li.append(btn);
    list.append(li);
    legendButtons.push(btn);
    legendCounts.push(count);
  });
}

/** Legend sub-line: the shell altitudes found in the data, where that's the useful detail. */
function legendDetail(gi) {
  const altitudes = (meta?.shells || []).filter((s) => s.group === gi).map((s) => `~${s.altitude}`);
  if ((gi === 0 || gi === 1) && altitudes.length) {
    const list = altitudes.length > 1 ? `${altitudes.slice(0, -1).join(', ')} and ${altitudes.at(-1)}` : altitudes[0];
    return `Shells at ${list} km`;
  }
  return GROUPS[gi].detail;
}

function updateLegendCounts() {
  const counts = GROUPS.map(() => 0);
  for (let i = 0; i < meta.count; i++) if (state.ok[i]) counts[meta.group[i]]++;
  counts.forEach((c, gi) => (legendCounts[gi].textContent = fmtInt.format(c)));
}

function updateInfo(info) {
  const i = info.index;
  $('info-lat').textContent = formatLat(info.lat);
  $('info-lon').textContent = formatLon(info.lon);
  $('info-alt').textContent = `${fmtInt.format(Math.round(info.altitude))} km`;
  $('info-speed').textContent = `${fmt2.format(info.speed)} km/s`;
  $('info-light').textContent = info.sunlit ? 'In sunlight' : "In Earth's shadow";
  const epochAge = clock.now() - meta.epoch[i];
  $('info-epoch').textContent = Number.isFinite(epochAge)
    ? `${formatAge(Math.abs(epochAge))} ${epochAge >= 0 ? 'ago' : 'ahead'}`
    : '—';
  const lookRow = $('info-look-row');
  if (info.look) {
    lookRow.hidden = false;
    $('info-look').textContent = info.look.elevation > 0
      ? `${fmt1.format(info.look.elevation)}° up · ${compass(info.look.azimuth)} · ${fmtInt.format(Math.round(info.look.range))} km`
      : `Below your horizon · ${fmtInt.format(Math.round(info.look.range))} km`;
  } else {
    lookRow.hidden = true;
  }
}

function fillInfoStatic(i) {
  $('info-name').textContent = meta.names[i];
  const cospar = meta.cospar[i];
  $('info-sub').textContent = `NORAD ${meta.norad[i]}${cospar ? ` · ${cospar}` : ''}${launchText(cospar)}`;
  $('info-shell').textContent = `${meta.shell[i]} · ${fmt1.format(meta.inclination[i])}° inclination`;
  $('info-swatch').style.setProperty('--c', GROUPS[meta.group[i]].color);
  $('info-period').textContent = Number.isFinite(meta.periodMin[i]) ? `${fmt1.format(meta.periodMin[i])} min` : '—';
  for (const id of ['info-lat', 'info-lon', 'info-alt', 'info-speed', 'info-light', 'info-epoch']) $(id).textContent = '…';
  $('info').hidden = false;
}

function launchText(cospar) {
  const m = /^(\d{4})-(\d{3})/.exec(cospar || '');
  return m ? ` · launched ${m[1]}` : '';
}

// ---------------------------------------------------------------------------------------------
// Selecting satellites
// ---------------------------------------------------------------------------------------------

function select(i, { fly = true } = {}) {
  if (!meta || i < 0 || i >= meta.count) return;
  const changed = i !== selected;
  selected = i;
  fillInfoStatic(i);
  if (lastSelectedInfo?.index === i) updateInfo(lastSelectedInfo);
  orbitLine.visible = false;
  groundLine.visible = false;
  trackTime = -Infinity;
  trackInFlight = false;
  forceTick = true;
  if (changed) setFollowing(false);
  if (!groupVisible[meta.group[i]]) {
    groupVisible[meta.group[i]] = true;
    legendButtons[meta.group[i]]?.setAttribute('aria-pressed', 'true');
    refreshVisibility();
  }
  if (fly && state && state.ok[i]) startFlight(i);
  history.replaceState(null, '', `#sat-${meta.norad[i]}`);
}

function deselect() {
  selected = -1;
  lastSelectedInfo = null;
  setFollowing(false);
  $('info').hidden = true;
  orbitLine.visible = false;
  groundLine.visible = false;
  selectMarker.visible = false;
  history.replaceState(null, '', location.pathname + location.search);
}

function setFollowing(on) {
  following = on;
  $('info-follow').setAttribute('aria-pressed', String(on));
  $('info-follow').textContent = on ? 'Following' : 'Follow';
  if (on && selected >= 0) startFlight(selected);
}

function readHashNorad() {
  const m = /sat[-=](\d+)/.exec(location.hash); // #sat-44714 (and the older #sat=44714)
  return m ? Number(m[1]) : null;
}

window.addEventListener('hashchange', () => {
  const norad = readHashNorad();
  if (norad == null || !meta) return;
  const idx = meta.norad.indexOf(norad);
  if (idx >= 0 && idx !== selected) select(idx);
});

// ---------------------------------------------------------------------------------------------
// Camera moves
// ---------------------------------------------------------------------------------------------

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const identityQ = new THREE.Quaternion();

const VIEW_TILT = THREE.MathUtils.degToRad(28);
const orbitNormal = new THREE.Vector3();

/**
 * Camera direction for looking at satellite i: above it, tilted out of its orbital plane so the
 * orbit line reads as a curve rather than a line seen edge-on. Tilts toward the camera's side.
 */
function viewDirection(i, simTime, out) {
  const k = i * 3;
  const p = state.pos;
  const v = state.vel;
  orbitNormal
    .set(p[k + 1] * v[k + 2] - p[k + 2] * v[k + 1], p[k + 2] * v[k] - p[k] * v[k + 2], p[k] * v[k + 1] - p[k + 1] * v[k])
    .normalize()
    .applyAxisAngle(Y_AXIS, inertial.rotation.y);
  if (orbitNormal.dot(camera.position) < 0) orbitNormal.negate();
  satLocalPosition(i, simTime, out).applyAxisAngle(Y_AXIS, inertial.rotation.y).normalize();
  return out.multiplyScalar(Math.cos(VIEW_TILT)).addScaledVector(orbitNormal, Math.sin(VIEW_TILT)).normalize();
}

function startFlight(i) {
  const distance = camera.position.length();
  flight = {
    index: i,
    from: camera.position.clone().normalize(),
    distFrom: distance,
    distTo: THREE.MathUtils.clamp(distance, 2.2, 4.2),
    start: performance.now(),
    duration: 1300,
  };
}

function startFlightToWorld(dir, distTo) {
  flight = {
    target: dir.clone().normalize(),
    from: camera.position.clone().normalize(),
    distFrom: camera.position.length(),
    distTo,
    start: performance.now(),
    duration: 1300,
  };
}

function updateCamera(simTime) {
  if (flight) {
    const t = Math.min(1, (performance.now() - flight.start) / flight.duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const target = flight.target ? tmpA.copy(flight.target) : viewDirection(flight.index, simTime, tmpA);
    tmpQ.setFromUnitVectors(flight.from, target);
    tmpB.copy(flight.from).applyQuaternion(identityQ.clone().slerp(tmpQ, e));
    camera.position.copy(tmpB.multiplyScalar(THREE.MathUtils.lerp(flight.distFrom, flight.distTo, e)));
    if (t >= 1) flight = null;
  } else if (following && selected >= 0 && state?.ok[selected]) {
    const distance = camera.position.length();
    camera.position.copy(viewDirection(selected, simTime, tmpA).multiplyScalar(distance));
  }
}

// Dragging the globe takes the camera back from a fly-to or follow; zooming doesn't.
function onUserDrag() {
  flight = null;
  if (following) setFollowing(false);
}

// ---------------------------------------------------------------------------------------------
// Picking (screen-space nearest satellite, ignoring ones hidden behind the Earth)
// ---------------------------------------------------------------------------------------------

const viewProj = new THREE.Matrix4();

function pick(clientX, clientY, radiusPx) {
  if (!state || !meta) return -1;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const w = rect.width;
  const h = rect.height;
  const simTime = clock.now();
  const angle = inertial.rotation.y;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = viewProj.elements;
  const cam = camera.position;
  const camLen2 = cam.lengthSq();
  const dt = (simTime - state.time) / 1000;
  const { pos, vel } = state;
  let best = -1;
  let bestD2 = radiusPx * radiusPx;

  for (let i = 0; i < meta.count; i++) {
    if (!visibleMask[i]) continue;
    const k = i * 3;
    const r = Math.hypot(pos[k], pos[k + 1], pos[k + 2]);
    const n = Math.sqrt(MU_SCENE / (r * r * r));
    const c = Math.cos(n * dt);
    const s = Math.sin(n * dt) / n;
    const lx = pos[k] * c + vel[k] * s;
    const ly = pos[k + 1] * c + vel[k + 1] * s;
    const lz = pos[k + 2] * c + vel[k + 2] * s;
    // Same rotation as the inertial group (about +Y).
    const x = lx * cosA + lz * sinA;
    const y = ly;
    const z = -lx * sinA + lz * cosA;
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 0) continue;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w;
    const sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5) * h;
    const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
    if (d2 >= bestD2) continue;
    // Occluded if the camera→satellite segment enters the unit sphere first.
    const dx = x - cam.x;
    const dy = y - cam.y;
    const dz = z - cam.z;
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (cam.x * dx + cam.y * dy + cam.z * dz);
    const disc = b * b - 4 * a * (camLen2 - 1);
    if (disc > 0) {
      const t1 = (-b - Math.sqrt(disc)) / (2 * a);
      if (t1 > 0 && t1 < 1) continue;
    }
    best = i;
    bestD2 = d2;
  }
  return best;
}

const pointer = { x: 0, y: 0, type: 'mouse', inside: false };
let down = null;

canvas.addEventListener('pointermove', (e) => {
  if (down && !down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
    down.dragging = true;
    onUserDrag();
  }
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.type = e.pointerType;
  pointer.inside = true;
});
canvas.addEventListener('pointerleave', () => {
  pointer.inside = false;
  setHover(-1);
});
canvas.addEventListener('pointercancel', () => (down = null));
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now(), dragging: false };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const quick = performance.now() - down.t < 600;
  down = null;
  if (moved > 6 || !quick || e.button > 0) return;
  if (picking) {
    const spot = earthPointAt(e.clientX, e.clientY);
    if (spot) {
      stopPicking();
      setObserver(spot.lat, spot.lon, 0);
    }
    return;
  }
  // With a mouse, click whatever the tooltip is showing; with touch, pick under the finger.
  const idx = e.pointerType === 'mouse' && hovered >= 0 ? hovered : pick(e.clientX, e.clientY, e.pointerType === 'touch' ? 24 : 12);
  if (idx >= 0) select(idx);
  else if (selected >= 0 && e.pointerType !== 'touch') deselect();
});

function setHover(i) {
  if (i === hovered) return;
  hovered = i;
  canvas.classList.toggle('hovering', i >= 0);
  if (i < 0) {
    $('tooltip').hidden = true;
    hoverMarker.visible = false;
  }
}

function updateHover(simTime) {
  if (picking) return;
  if (pointer.inside && pointer.type === 'mouse' && !down && state) {
    // Re-pick every frame while the mouse is over the globe: satellites move under a still cursor.
    setHover(pick(pointer.x, pointer.y, 10));
  }
  if (hovered < 0 || !state) return;
  const tip = $('tooltip');
  const altitude = state.alt[hovered];
  tip.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = meta.names[hovered];
  tip.append(strong, `${meta.shell[hovered]} · ${fmtInt.format(Math.round(altitude))} km`);
  tip.hidden = false;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const left = pointer.x + 16 + tw > window.innerWidth ? pointer.x - 16 - tw : pointer.x + 16;
  const top = Math.min(window.innerHeight - th - 8, pointer.y + 14);
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  hoverMarker.visible = hovered !== selected;
  satLocalPosition(hovered, simTime, hoverMarker.position);
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

const searchInput = $('search');
const resultsList = $('search-results');
let results = [];
let activeResult = -1;

function runSearch() {
  const q = searchInput.value.trim().toUpperCase();
  results = [];
  activeResult = -1;
  if (!q || !meta) return renderResults();
  const digits = /^\d+$/.test(q);
  const starts = [];
  const contains = [];
  for (let i = 0; i < meta.count; i++) {
    const name = meta.searchNames[i];
    if (digits && String(meta.norad[i]).startsWith(q)) starts.push(i);
    else if (name.startsWith(q) || name.replace('STARLINK-', '').startsWith(q)) starts.push(i);
    else if (name.includes(q) || meta.cospar[i].toUpperCase().includes(q)) contains.push(i);
    if (starts.length >= 8) break;
  }
  results = starts.concat(contains).slice(0, 8);
  if (results.length) activeResult = 0;
  renderResults();
}

function renderResults() {
  resultsList.replaceChildren();
  const open = searchInput.value.trim() !== '' && document.activeElement === searchInput;
  resultsList.hidden = !open;
  searchInput.setAttribute('aria-expanded', String(open));
  if (!open) return;
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'r-empty';
    li.textContent = 'No Starlink satellite matches that.';
    resultsList.append(li);
    return;
  }
  results.forEach((idx, k) => {
    const li = document.createElement('li');
    li.id = `result-${k}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(k === activeResult));
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.setProperty('--c', GROUPS[meta.group[idx]].color);
    const name = document.createElement('span');
    name.className = 'r-name';
    name.textContent = meta.names[idx];
    const metaText = document.createElement('span');
    metaText.className = 'r-meta';
    metaText.textContent = `NORAD ${meta.norad[idx]}`;
    li.append(swatch, name, metaText);
    li.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      chooseResult(idx);
    });
    resultsList.append(li);
  });
  searchInput.setAttribute('aria-activedescendant', activeResult >= 0 ? `result-${activeResult}` : '');
}

function chooseResult(idx) {
  searchInput.value = '';
  results = [];
  renderResults();
  searchInput.blur();
  if (state && !state.ok[idx]) {
    toast(`${meta.names[idx]} has no valid position right now.`);
    return;
  }
  select(idx);
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('focus', runSearch);
searchInput.addEventListener('blur', () => setTimeout(renderResults, 0));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderResults();
  } else if (e.key === 'Enter') {
    if (activeResult >= 0) chooseResult(results[activeResult]);
  } else if (e.key === 'Escape') {
    searchInput.value = '';
    runSearch();
    searchInput.blur();
  }
});

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === 'Escape' && !typing && picking) {
    stopPicking();
  } else if (e.key === 'Escape' && !typing && selected >= 0) {
    deselect();
  }
});

// ---------------------------------------------------------------------------------------------
// Info card, time controls, location
// ---------------------------------------------------------------------------------------------

$('info-close').addEventListener('click', deselect);
$('info-follow').addEventListener('click', () => setFollowing(!following));

const speedButtons = [...document.querySelectorAll('.speeds button')];
speedButtons.forEach((btn) =>
  btn.addEventListener('click', () => {
    clock.setRate(Number(btn.dataset.rate));
    forceTick = true;
    updateTimeUi();
  }),
);
$('btn-pause').addEventListener('click', () => {
  clock.togglePause();
  forceTick = true;
  updateTimeUi();
});
$('btn-live').addEventListener('click', () => {
  clock.goLive();
  forceTick = true;
  trackTime = -Infinity;
  updateTimeUi();
});

function updateTimeUi() {
  speedButtons.forEach((btn) => btn.setAttribute('aria-checked', String(Number(btn.dataset.rate) === clock.rate)));
  const pause = $('btn-pause');
  pause.classList.toggle('paused', clock.paused);
  pause.setAttribute('aria-label', clock.paused ? 'Play' : 'Pause');
  const live = clock.isLive();
  const badge = $('mode-badge');
  badge.className = `badge ${live ? 'badge-live' : 'badge-sim'}`;
  $('mode-label').textContent = live ? 'Live' : clock.paused ? 'Paused' : `${clock.rate}× speed`;
  $('btn-live').hidden = live;
}

let lastClockText = '';
function updateClock(simTime) {
  const iso = new Date(simTime).toISOString();
  if (iso.slice(0, 19) === lastClockText) return;
  lastClockText = iso.slice(0, 19);
  $('sim-date').textContent = iso.slice(0, 10);
  $('sim-clock').textContent = `${iso.slice(11, 19)} UTC`;
  $('sim-time').dateTime = iso;
}

$('btn-locate').addEventListener('click', () => {
  if (observer) {
    observer = null;
    send({ type: 'observer', observer: null });
    observerMarker.visible = false;
    beams.visible = false;
    $('observer-stats').hidden = true;
    $('btn-locate-label').textContent = 'Satellites above me';
    $('btn-locate').setAttribute('aria-pressed', 'false');
    $('info-look-row').hidden = true;
    return;
  }
  if (picking) {
    stopPicking();
    return;
  }
  if (!('geolocation' in navigator)) {
    startPicking("This browser can't share your location.");
    return;
  }
  $('btn-locate-label').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      const heightKm = Number.isFinite(pos.coords.altitude) ? pos.coords.altitude / 1000 : 0;
      setObserver(lat, lon, heightKm);
    },
    (err) => {
      $('btn-locate-label').textContent = 'Satellites above me';
      startPicking(err.code === err.PERMISSION_DENIED ? "Location access isn't available here." : "Couldn't get your location.");
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
  );
});

// Without location access, the viewer taps the globe to say where they are.
let picking = false;
const raycaster = new THREE.Raycaster();
const earthSphere = new THREE.Sphere(new THREE.Vector3(), 1);

function startPicking(reason) {
  picking = true;
  setHover(-1);
  $('pick-text').textContent = `${reason} Tap the globe where you are.`;
  $('pick-banner').hidden = false;
  canvas.classList.add('picking');
}

function stopPicking() {
  picking = false;
  $('pick-banner').hidden = true;
  canvas.classList.remove('picking');
}
$('pick-cancel').addEventListener('click', stopPicking);

/** Latitude/longitude under a screen point, or null if the point misses the Earth. */
function earthPointAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectSphere(earthSphere, new THREE.Vector3());
  if (!hit) return null;
  return {
    lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(hit.y, -1, 1))),
    lon: THREE.MathUtils.radToDeg(Math.atan2(-hit.z, hit.x)),
  };
}

function setObserver(lat, lon, heightKm) {
  const [x, y, z] = surfaceVector(lat, lon, 1.0);
  observer = { lat, lon, world: new THREE.Vector3(x, y, z) };
  send({ type: 'observer', observer: { lat, lon, heightKm } });
  observerMarker.position.copy(observer.world).multiplyScalar(1.002);
  observerMarker.visible = true;
  $('btn-locate-label').textContent = 'Clear my location';
  $('btn-locate').setAttribute('aria-pressed', 'true');
  $('observer-stats').hidden = false;
  forceTick = true;
  setFollowing(false);
  startFlightToWorld(observer.world, 2.6);
}

function updateObserverStats() {
  if (!observer || !state?.overhead) {
    beams.visible = false;
    return;
  }
  const list = state.overhead;
  let horizon = 0;
  let dish = 0;
  let highest = -1;
  let highestEl = -Infinity;
  for (let k = 0; k < list.length; k += 4) {
    horizon++;
    if (list[k + 1] >= DISH_MIN_ELEVATION) dish++;
    if (list[k + 1] > highestEl) {
      highestEl = list[k + 1];
      highest = list[k];
    }
  }
  $('obs-dish').textContent = fmtInt.format(dish);
  $('obs-horizon').textContent = fmtInt.format(horizon);
  const btn = $('obs-highest');
  if (highest >= 0) {
    btn.hidden = false;
    btn.textContent = `Highest: ${meta.names[highest]} at ${Math.round(highestEl)}°`;
    btn.onclick = () => select(highest);
  } else {
    btn.hidden = true;
  }
}

function updateBeams(simTime) {
  if (!observer || !state?.overhead) {
    beams.visible = false;
    return;
  }
  // Observer position in the inertial group's frame (undo the group's rotation).
  const origin = tmpB.copy(observer.world).applyAxisAngle(Y_AXIS, -inertial.rotation.y);
  const list = state.overhead;
  let n = 0;
  for (let k = 0; k < list.length && n < MAX_BEAMS; k += 4) {
    const i = list[k];
    if (list[k + 1] < DISH_MIN_ELEVATION || !visibleMask[i]) continue;
    satLocalPosition(i, simTime, tmpA);
    beamPositions.set([origin.x, origin.y, origin.z, tmpA.x, tmpA.y, tmpA.z], n * 6);
    n++;
  }
  beamGeometry.setDrawRange(0, n * 2);
  beamGeometry.getAttribute('position').needsUpdate = true;
  beams.visible = n > 0;
}

// ---------------------------------------------------------------------------------------------
// Loader, toast, errors
// ---------------------------------------------------------------------------------------------

function setLoader(text) {
  $('loader-msg').textContent = text;
}

function hideLoader() {
  $('loader').classList.add('done');
  setTimeout(() => ($('loader').hidden = true), 700);
}

function showFatal(message, retry = false) {
  const loader = $('loader');
  loader.hidden = false;
  loader.classList.remove('done');
  loader.classList.add('error');
  setLoader(message);
  $('loader-retry').hidden = !retry;
}

$('loader-retry').addEventListener('click', () => {
  $('loader').classList.remove('error');
  $('loader-retry').hidden = true;
  loadData({ initial: true });
});

let toastTimer = 0;
function toast(message) {
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 9000);
}
$('toast-close').addEventListener('click', () => ($('toast').hidden = true));

// ---------------------------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Keep the whole globe in view on narrow portrait screens.
  camera.fov = w < h ? THREE.MathUtils.clamp(42 * (h / w) * 0.75, 42, 70) : 42;
  camera.updateProjectionMatrix();
  satUniforms.uPixelRatio.value = renderer.getPixelRatio();
}
window.addEventListener('resize', resize);
resize();

const sunEci = new THREE.Vector3();
const sunWorld = new THREE.Vector3();
let lastUiUpdate = 0;

function frame(perfNow) {
  requestAnimationFrame(frame);
  const simTime = clock.now();

  inertial.rotation.y = -gmst(simTime);
  const [sx, sy, sz] = sunDirectionEci(simTime);
  sunEci.set(sx, sz, -sy);
  satUniforms.uSun.value.copy(sunEci);
  earth.setSunDirection(sunWorld.copy(sunEci).applyAxisAngle(Y_AXIS, inertial.rotation.y));

  maybeTick(perfNow, simTime);
  maybeTrack(perfNow, simTime);

  if (state) {
    satUniforms.uDt.value = (simTime - state.time) / 1000;
    if (selected >= 0 && state.ok[selected]) {
      satLocalPosition(selected, simTime, selectMarker.position);
      selectMarker.visible = true;
    } else {
      selectMarker.visible = false;
    }
    updateBeams(simTime);
  }

  // Slower rotation when zoomed in close.
  controls.rotateSpeed = THREE.MathUtils.clamp((camera.position.length() - 1) * 0.35, 0.06, 0.8);
  updateCamera(simTime);
  controls.update();
  updateHover(simTime);

  if (perfNow - lastUiUpdate > 250) {
    lastUiUpdate = perfNow;
    updateClock(simTime);
    updateTimeUi();
  }

  renderer.render(scene, camera);
}

updateTimeUi();
requestAnimationFrame(frame);
loadData({ initial: true });

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function formatLat(lat) {
  return `${fmt2.format(Math.abs(lat))}° ${lat >= 0 ? 'N' : 'S'}`;
}

function formatLon(lon) {
  const l = ((lon + 540) % 360) - 180;
  return `${fmt2.format(Math.abs(l))}° ${l >= 0 ? 'E' : 'W'}`;
}

function compass(azimuth) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(azimuth / 45) % 8];
}

function makeRingTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 7;
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePinTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const x = size / 2;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#03050b';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x, size * 0.92);
  ctx.bezierCurveTo(x - 10, size * 0.72, x - 38, size * 0.55, x - 38, size * 0.38);
  ctx.arc(x, size * 0.38, 38, Math.PI, 0);
  ctx.bezierCurveTo(x + 38, size * 0.55, x + 10, size * 0.72, x, size * 0.92);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = '#338ced';
  ctx.beginPath();
  ctx.arc(x, size * 0.38, 14, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
