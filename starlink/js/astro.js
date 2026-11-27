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
  { key: 'mid53', label: '53° shells', color: '#338ced', detail: 'The original and largest shells' },
  { key: 'mid43', label: '43° shell', color: '#e76624', detail: 'Mid-latitude Gen2 shell' },
  { key: 'polar', label: 'Polar shells', color: '#00a888', detail: '70° and 97.6° orbits' },
  { key: 'other', label: 'Other orbits', color: '#8f98ab', detail: '33° shell, orbit raising, deorbiting' },
];

/** Altitude below which a Starlink is climbing to, or descending from, its operational shell. */
export const TRANSIT_ALTITUDE_KM = 420;

/** Sorts a satellite into a colour group and a human-readable shell name. */
export function classify(inclinationDeg, meanAltitudeKm) {
  const inc = inclinationDeg;
  if (!(meanAltitudeKm >= TRANSIT_ALTITUDE_KM)) {
    return { group: 3, shell: 'Orbit raising or deorbiting' };
  }
  if (inc >= 52 && inc <= 54.5) return { group: 0, shell: `53° shell` };
  if (inc >= 42 && inc <= 44.5) return { group: 1, shell: '43° shell' };
  if (inc >= 69 && inc <= 71) return { group: 2, shell: '70° polar shell' };
  if (inc >= 96 && inc <= 99.5) return { group: 2, shell: '97.6° sun-synchronous shell' };
  if (inc >= 32 && inc <= 34.5) return { group: 3, shell: '33° shell' };
  return { group: 3, shell: 'Non-standard orbit' };
}
