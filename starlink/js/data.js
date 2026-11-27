// Loads Starlink orbital elements (CelesTrak GP data, OMM/JSON format).
//
// CelesTrak publishes new GP data every 2 hours and answers a repeat download of unchanged data with
// HTTP 403, so the page keeps its own copy for 2 hours and tries sources in this order:
//   1. this browser's cached copy, if it is less than 2 hours old;
//   2. the snapshot published next to the site (data/starlink.json, written by the GitHub Pages
//      workflow) if it is fresh, so visitors of a deployed site never hit CelesTrak themselves;
//   3. CelesTrak directly;
//   4. the newest stale copy we have, with a warning.
// JSON is used rather than TLE because new objects (catalog numbers above 99999) only exist in OMM.

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json';
// Relative to the page, so the same code works on the site and in a single-file bundle.
const SNAPSHOT_URL = new URL('data/starlink.json', document.baseURI);
const SNAPSHOT_META_URL = new URL('data/meta.json', document.baseURI);
// A page with <meta name="starlink-data" content="snapshot-only"> (for hosts that block requests to
// other sites) uses only the snapshot published with it and never contacts CelesTrak.
const SNAPSHOT_ONLY = document.querySelector('meta[name="starlink-data"]')?.content === 'snapshot-only';
const CACHE_KEY = 'starlink-tracker:gp:v1';
const BACKOFF_KEY = 'starlink-tracker:celestrak-backoff';

export const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const CELESTRAK_RETRY_MS = 15 * 60 * 1000;
const SNAPSHOT_FRESH_MS = 3 * 60 * 60 * 1000; // the workflow runs every 2 h; allow for queue delays

// Only the fields SGP4 needs (plus identity) are kept in the browser cache to stay well under quota.
const FIELDS = [
  'OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
];

export const SOURCE_LABELS = {
  celestrak: 'CelesTrak',
  snapshot: 'CelesTrak (site snapshot)',
};

/**
 * @param {{have?: {fetchedAt: number, source: string} | null}} options
 *   `have`: the data the page is already showing, if any.
 * @returns {Promise<{rows: object[], fetchedAt: number, source: string, stale: boolean, warning?: string} | null>}
 *   `null` means nothing newer is available and the data in `have` is still good to use.
 */
export async function loadElements({ have = null } = {}) {
  if (SNAPSHOT_ONLY) {
    const snapshot = await findSnapshot(have?.fetchedAt || 0);
    if (snapshot) return { ...snapshot, rows: await snapshot.download(), stale: false };
    if (have) return null;
    throw new Error('the orbital data published with this page is missing');
  }
  const now = Date.now();
  const cached = readCache();
  const age = (d) => now - d.fetchedAt;
  // The newest data already on hand; the page's own copy counts too, in case storage is unavailable.
  const known = [cached, have].filter(Boolean).reduce((a, b) => (!a || b.fetchedAt > a.fetchedAt ? b : a), null);
  const keepKnown = () => (known === cached ? { ...cached, stale: false } : null);

  if (known && age(known) < REFRESH_INTERVAL_MS) return keepKnown();

  const fallbacks = cached ? [cached] : [];
  let lastError = null;
  let staleSnapshot = null;

  try {
    const snapshot = await findSnapshot(known?.fetchedAt || 0); // only if newer than what we hold
    if (snapshot && age(snapshot) < SNAPSHOT_FRESH_MS) {
      const fresh = { ...snapshot, rows: await snapshot.download() };
      writeCache(fresh);
      return { ...fresh, stale: false };
    }
    staleSnapshot = snapshot; // downloaded only if CelesTrak fails too
  } catch (err) {
    lastError = err;
  }
  // A deployed site's snapshot is refreshed every 2 hours; give a late workflow run some slack
  // before falling back to CelesTrak.
  if (known?.source === 'snapshot' && age(known) < SNAPSHOT_FRESH_MS) return keepKnown();

  const backoffUntil = readBackoff();
  if (now < backoffUntil) {
    lastError = lastError || new Error(`CelesTrak was unavailable; next try in ${formatAge(backoffUntil - now)}`);
  } else {
    try {
      const live = await fetchCelestrak();
      writeCache(live);
      return { ...live, stale: false };
    } catch (err) {
      lastError = err;
      // CelesTrak asks clients to stop after any error; don't ask again for a while (across reloads).
      writeBackoff(now + (err.status === 403 ? REFRESH_INTERVAL_MS : CELESTRAK_RETRY_MS));
    }
  }

  if (staleSnapshot) {
    try {
      fallbacks.push({ ...staleSnapshot, rows: await staleSnapshot.download() });
    } catch {
      // keep whatever else we have
    }
  }
  const best = fallbacks.reduce((a, b) => (!a || b.fetchedAt > a.fetchedAt ? b : a), null);
  if (best && (!have || best.fetchedAt > have.fetchedAt)) {
    return {
      ...best,
      stale: true,
      warning: `Couldn't refresh orbital elements (${lastError?.message || 'network error'}). Showing data from ${formatAge(age(best))} ago.`,
    };
  }
  if (have) return null; // keep showing what we have; the page reports the age
  throw lastError || new Error('No orbital data source is reachable.');
}

async function fetchCelestrak() {
  let res;
  try {
    res = await fetch(CELESTRAK_URL); // a "simple" request: no custom headers, so no CORS preflight
  } catch {
    throw new Error("couldn't reach CelesTrak");
  }
  if (!res.ok) {
    const err = new Error(
      res.status === 403
        ? 'CelesTrak allows one download every 2 hours per network; try again later'
        : `CelesTrak answered HTTP ${res.status}`,
    );
    err.status = res.status;
    throw err;
  }
  const rows = validate(await res.json().catch(() => null), 'CelesTrak');
  return { rows, fetchedAt: Date.now(), source: 'celestrak' };
}

/** Reads the snapshot's metadata; the (large) element file is fetched only via `download()`. */
async function findSnapshot(newerThan) {
  const metaRes = await fetch(SNAPSHOT_META_URL, { cache: 'no-cache' }).catch(() => null);
  if (!metaRes || !metaRes.ok) return null;
  const meta = await metaRes.json().catch(() => null);
  const fetchedAt = Date.parse(meta?.fetched_at); // null in the placeholder committed to the repo
  if (!Number.isFinite(fetchedAt) || fetchedAt <= newerThan) return null;
  return {
    fetchedAt,
    source: 'snapshot',
    async download() {
      const res = await fetch(SNAPSHOT_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`snapshot answered HTTP ${res.status}`);
      return validate(await res.json().catch(() => null), 'the snapshot');
    },
  };
}

function validate(rows, from) {
  if (!Array.isArray(rows) || rows.length === 0 || rows[0].MEAN_MOTION === undefined) {
    throw new Error(`unexpected data from ${from}`);
  }
  return rows;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.rows) || !Number.isFinite(data.fetchedAt)) return null;
    const rows = data.rows.map((values) => {
      const row = {};
      FIELDS.forEach((field, i) => (row[field] = values[i]));
      return row;
    });
    return { rows, fetchedAt: data.fetchedAt, source: data.source };
  } catch {
    return null;
  }
}

function writeCache({ rows, fetchedAt, source }) {
  try {
    const compact = rows.map((row) => FIELDS.map((field) => row[field]));
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt, source, rows: compact }));
  } catch {
    // Storage full, disabled or private mode: the page still works, it just re-downloads next visit.
  }
}

function readBackoff() {
  try {
    return Number(localStorage.getItem(BACKOFF_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeBackoff(until) {
  try {
    localStorage.setItem(BACKOFF_KEY, String(until));
  } catch {
    // ignore
  }
}

export function formatAge(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'moments';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}
