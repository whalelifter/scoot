// Shared astronomy helpers and the shell grouping, used by both the page and the propagation worker.
//
// Scene axes: the globe is drawn with Y pointing at the north pole. Inertial (TEME/ECI) vectors are
// mapped as  scene.x = eci.x,  scene.y = eci.z,  scene.z = -eci.y  (a proper rotation), and one scene
// unit is the mean Earth radius. Earth-fixed (ECEF) vectors use the same mapping, so longitude 0 is +X
// and longitude 90°E is -Z.

export const EARTH_RADIUS_KM = 6371.0;
export const MU_KM3_S2 = 398600.4418;
/** Gravitational parameter in scene units (Earth radii³ / s²), used to extrapolate between SGP4 runs. */
export const MU_SCENE = MU_KM3_S2 / EARTH_RADIUS_KM ** 3;

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

export const julianDate = (ms) => ms / 86400000 + 2440587.5;

/** Greenwich mean sidereal time in radians (IAU-82, the model SGP4/satellite.js uses). */
export function gmst(ms) {
  const t = (julianDate(ms) - 2451545.0) / 36525.0;
  const seconds =
    -6.2e-6 * t * t * t + 0.093104 * t * t + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;
  let theta = ((seconds * DEG) / 240.0) % TWO_PI;
  if (theta < 0) theta += TWO_PI;
  return theta;
}

/**
 * Unit vector from the Earth toward the Sun in the inertial frame (Astronomical Almanac low-precision
 * formula, ~0.01° accuracy). Returned in ECI axes as [x, y, z].
 */
export function sunDirectionEci(ms) {
  const n = julianDate(ms) - 2451545.0;
  const meanLon = (280.46 + 0.9856474 * n) * DEG;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLon =
    meanLon + (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;
  return [
    Math.cos(eclipticLon),
    Math.cos(obliquity) * Math.sin(eclipticLon),
    Math.sin(obliquity) * Math.sin(eclipticLon),
  ];
}

/** Earth-fixed unit vector (scene axes) for a geodetic latitude/longitude in degrees. */
export function surfaceVector(latDeg, lonDeg, radius = 1) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * Math.cos(lat) * Math.sin(lon),
  ];
}

// Colour groups. Only three hues plus a neutral grey are used so every pair stays distinguishable,
// including for colour-blind viewers; the finer shell name is shown in the tooltip and info card.
export const GROUPS = [
  { key: 'mid53', label: '53° shells', color: '#338ced', detail: 'The largest group of shells' },
  { key: 'mid43', label: '43° shells', color: '#e76624', detail: 'Mid-latitude shells' },
  { key: 'polar', label: 'Polar shells', color: '#00a888', detail: '70° and 97.6° orbits' },
  { key: 'other', label: 'Other orbits', color: '#8f98ab', detail: 'Low-inclination shell, and satellites raising or lowering their orbit' },
];

const FAMILIES = [
  { name: '53°', min: 52, max: 54.5, group: 0 },
  { name: '43°', min: 42, max: 44.5, group: 1 },
  { name: '70°', min: 69, max: 71, group: 2 },
  { name: '97.6°', min: 96, max: 99.5, group: 2 },
  { name: '33°', min: 30, max: 34.5, group: 3 },
];
const BIN_KM = 5;
const SHELL_HALF_WIDTH_KM = 10;

/**
 * Sorts every satellite into a colour group and names its shell. Shells aren't hard-coded: SpaceX
 * moves them (most were lowered from ~550 km to ~480 km in 2026), so for each inclination family the
 * densely populated altitude bands count as shells, and anything outside them is raising or lowering.
 *
 * @returns {{group: Uint8Array, shell: string[], shells: {family: string, group: number, altitude: number, count: number}[]}}
 */
export function classifyAll(inclination, meanAltitude) {
  const n = inclination.length;
  const family = new Int8Array(n).fill(-1);
  const bins = FAMILIES.map(() => new Map());
  const totals = FAMILIES.map(() => 0);
  for (let i = 0; i < n; i++) {
    const f = FAMILIES.findIndex((fam) => inclination[i] >= fam.min && inclination[i] <= fam.max);
    if (f < 0 || !Number.isFinite(meanAltitude[i])) continue;
    family[i] = f;
    totals[f]++;
    const bin = Math.floor(meanAltitude[i] / BIN_KM);
    bins[f].set(bin, (bins[f].get(bin) || 0) + 1);
  }

  // Dense bins (≥ 5% of the family, and at least 30 satellites), merged when within 10 km.
  const shellsByFamily = FAMILIES.map((fam, f) => {
    const threshold = Math.max(30, totals[f] * 0.05);
    const dense = [...bins[f]].filter(([, c]) => c >= threshold).sort((a, b) => a[0] - b[0]);
    const shells = [];
    for (const [bin, count] of dense) {
      const centre = (bin + 0.5) * BIN_KM;
      const last = shells[shells.length - 1];
      if (last && centre - last.hi <= 2 * BIN_KM) {
        last.hi = centre;
        last.sum += centre * count;
        last.count += count;
      } else {
        shells.push({ lo: centre, hi: centre, sum: centre * count, count });
      }
    }
    return shells.map((s) => ({ ...s, altitude: Math.round(s.sum / s.count / 10) * 10 }));
  });

  const group = new Uint8Array(n).fill(3);
  const shell = new Array(n).fill('Non-standard orbit');
  for (let i = 0; i < n; i++) {
    const f = family[i];
    if (f < 0) continue;
    const a = meanAltitude[i];
    const match = shellsByFamily[f].find((s) => a >= s.lo - SHELL_HALF_WIDTH_KM && a <= s.hi + SHELL_HALF_WIDTH_KM);
    if (match) {
      group[i] = FAMILIES[f].group;
      shell[i] = `${FAMILIES[f].name} shell at ~${match.altitude} km`;
    } else {
      shell[i] = `${FAMILIES[f].name}, raising or lowering orbit`;
    }
  }

  const shells = shellsByFamily.flatMap((list, f) =>
    list.map((s) => ({ family: FAMILIES[f].name, group: FAMILIES[f].group, altitude: s.altitude, count: s.count })),
  );
  return { group, shell, shells };
}
