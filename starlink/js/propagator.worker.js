// Runs SGP4 for the whole constellation off the main thread.
//
// Messages in:  init {rows}            build satrecs from CelesTrak OMM/JSON records
//               tick {time, selected}  propagate every satellite to `time` (ms since epoch)
//               track {index, time}    one orbit of positions + ground track for a single satellite
//               observer {observer}    {lat, lon, heightKm} in degrees, or null to clear
// Messages out: ready, state, track, error (see each handler).

import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@6.0.2/dist/satellite.es.min.js';
import { EARTH_RADIUS_KM, MU_KM3_S2, sunDirectionEci, surfaceVector } from './astro.js';

const R = EARTH_RADIUS_KM;
const R2 = R * R;
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const WGS84_EQUATORIAL_KM = 6378.137;
/** Below this the model says the satellite has re-entered, or its elements have gone bad. */
const MIN_ALTITUDE_KM = 100;
const TRACK_SAMPLES = 240;

let satrecs = [];
let count = 0;
let observer = null; // satellite.js geodetic observer {latitude, longitude, height} in radians / km

self.onmessage = ({ data: msg }) => {
  try {
    if (msg.type === 'init') init(msg);
    else if (msg.type === 'tick') tick(msg);
    else if (msg.type === 'track') track(msg);
    else if (msg.type === 'observer') setObserver(msg.observer);
  } catch (err) {
    self.postMessage({ type: 'error', request: msg.type, message: String(err?.message || err) });
  }
};

function init({ rows }) {
  count = rows.length;
  satrecs = new Array(count);
  const names = new Array(count);
  const cospar = new Array(count);
  const norad = new Float64Array(count);
  const inclination = new Float32Array(count);
  const meanAltitude = new Float32Array(count);
  const periodMin = new Float32Array(count);
  const epoch = new Float64Array(count);
  let usable = 0;

  for (let i = 0; i < count; i++) {
    const row = rows[i];
    norad[i] = Number(row.NORAD_CAT_ID) || 0;
    names[i] = String(row.OBJECT_NAME || `NORAD ${norad[i]}`).trim();
    cospar[i] = String(row.OBJECT_ID || '').trim();
    inclination[i] = Number(row.INCLINATION);
    const revsPerDay = Number(row.MEAN_MOTION);
    periodMin[i] = revsPerDay > 0 ? 1440 / revsPerDay : NaN;
    const n = (revsPerDay * 2 * Math.PI) / 86400; // rad/s
    meanAltitude[i] = n > 0 ? Math.cbrt(MU_KM3_S2 / (n * n)) - WGS84_EQUATORIAL_KM : NaN;
    const epochText = String(row.EPOCH || '');
    epoch[i] = Date.parse(epochText.endsWith('Z') ? epochText : `${epochText}Z`);

    let rec = null;
    try {
      rec = satellite.json2satrec(row);
      if (rec.error) rec = null;
    } catch {
      rec = null;
    }
    satrecs[i] = rec;
    if (rec) usable++;
  }

  self.postMessage(
    { type: 'ready', count, usable, names, cospar, norad, inclination, meanAltitude, periodMin, epoch },
    [norad.buffer, inclination.buffer, meanAltitude.buffer, periodMin.buffer, epoch.buffer],
  );
}

function setObserver(o) {
  observer = o
    ? { latitude: o.lat * DEG2RAD, longitude: o.lon * DEG2RAD, height: (o.heightKm || 0) }
    : null;
}

/**
 * Propagates every satellite. Posts positions/velocities in scene units (Earth radii, Earth radii/s,
 * inertial frame), geodetic altitude, a usable flag, summary stats, details for the selected
 * satellite, and — when an observer is set — the satellites above their horizon.
 */
function tick({ time, selected = -1 }) {
  const date = new Date(time);
  const gmst = satellite.gstime(date);
  const [sx, sy, sz] = sunDirectionEci(time);

  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const alt = new Float32Array(count);
  const ok = new Uint8Array(count);
  const overhead = [];
  let live = 0;
  let sunlit = 0;
  let altitudeSum = 0;
  let selectedInfo = null;

  for (let i = 0; i < count; i++) {
    const rec = satrecs[i];
    if (!rec) continue;
    const pv = satellite.propagate(rec, date);
    if (!pv) continue;
    const p = pv.position;
    const v = pv.velocity;
    if (!Number.isFinite(p.x) || !Number.isFinite(v.x)) continue;
    const geo = satellite.eciToGeodetic(p, gmst);
    if (!(geo.height > MIN_ALTITUDE_KM)) continue;

    const k = i * 3;
    pos[k] = p.x / R;
    pos[k + 1] = p.z / R;
    pos[k + 2] = -p.y / R;
    vel[k] = v.x / R;
    vel[k + 1] = v.z / R;
    vel[k + 2] = -v.y / R;
    alt[i] = geo.height;
    ok[i] = 1;
    live++;
    altitudeSum += geo.height;

    // Cylindrical Earth-shadow test: lit unless behind the Earth and inside its shadow cylinder.
    const along = p.x * sx + p.y * sy + p.z * sz;
    const lit = along > 0 || p.x * p.x + p.y * p.y + p.z * p.z - along * along > R2;
    if (lit) sunlit++;

    let look = null;
    if (observer) {
      look = satellite.ecfToLookAngles(observer, satellite.eciToEcf(p, gmst));
      if (look.elevation > 0) overhead.push(i, look.elevation * RAD2DEG, look.azimuth * RAD2DEG, look.rangeSat);
    }

    if (i === selected) {
      selectedInfo = {
        index: i,
        lat: satellite.degreesLat(geo.latitude),
        lon: satellite.degreesLong(geo.longitude),
        altitude: geo.height,
        speed: Math.hypot(v.x, v.y, v.z),
        sunlit: lit,
        look: look && {
          elevation: look.elevation * RAD2DEG,
          azimuth: look.azimuth * RAD2DEG,
          range: look.rangeSat,
        },
      };
    }
  }

  const overheadArr = Float64Array.from(overhead);
  self.postMessage(
    {
      type: 'state',
      time,
      pos,
      vel,
      alt,
      ok,
      stats: { live, sunlit, meanAltitude: live ? altitudeSum / live : NaN },
      selected: selectedInfo,
      overhead: observer ? overheadArr : null,
    },
    [pos.buffer, vel.buffer, alt.buffer, ok.buffer, overheadArr.buffer],
  );
}

/** One full orbit (inertial frame) and the matching ground track (Earth-fixed), starting at `time`. */
function track({ index, time }) {
  const rec = satrecs[index];
  if (!rec) {
    self.postMessage({ type: 'track', index, time, points: 0 });
    return;
  }
  const periodMs = ((2 * Math.PI) / rec.no) * 60000; // rec.no is rad/min
  const orbit = new Float32Array((TRACK_SAMPLES + 1) * 3);
  const ground = new Float32Array((TRACK_SAMPLES + 1) * 3);
  let points = 0;
  for (let s = 0; s <= TRACK_SAMPLES; s++) {
    const t = time + (periodMs * s) / TRACK_SAMPLES;
    const date = new Date(t);
    const pv = satellite.propagate(rec, date);
    if (!pv || !Number.isFinite(pv.position.x)) break;
    const p = pv.position;
    const k = s * 3;
    orbit[k] = p.x / R;
    orbit[k + 1] = p.z / R;
    orbit[k + 2] = -p.y / R;
    const geo = satellite.eciToGeodetic(p, satellite.gstime(date));
    const g = surfaceVector(geo.latitude * RAD2DEG, geo.longitude * RAD2DEG, 1.003);
    ground[k] = g[0];
    ground[k + 1] = g[1];
    ground[k + 2] = g[2];
    points++;
  }
  self.postMessage({ type: 'track', index, time, points, orbit, ground }, [orbit.buffer, ground.buffer]);
}
