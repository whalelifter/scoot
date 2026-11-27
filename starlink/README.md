# Starlink Live

A website that shows every Starlink satellite in orbit on a 3D globe, positioned in real time.

- **Every satellite, live.** Positions come from the latest public orbital elements, run through the
  SGP4 orbit model a couple of times a second for the whole constellation. In between, each dot is
  moved along its orbit on the GPU, so motion is smooth at 60 fps.
- **Orbital shells.** Satellites are coloured by inclination: 53°, 43°, polar (70° and 97.6°), and
  other orbits. Shells are found in the data itself, as densely populated altitude bands, because
  SpaceX moves them; in November 2026 the main ones sit near 350–360 km and 460–480 km. Satellites
  outside a band are labelled as raising or lowering their orbit. Click a shell in the legend to show
  or hide it.
- **Real lighting.** Day and night on the globe follow the real Sun. Satellites inside Earth's shadow
  are drawn dimmed. The panel counts how many are in sunlight right now.
- **Look up any satellite.** Search by name or NORAD ID, or click a dot. The details card shows
  latitude, longitude, altitude, speed, period and lighting. The globe draws the satellite's next
  orbit and its ground track. **Follow** keeps the camera on it. Links like `#sat-44713` open with
  that satellite selected.
- **Satellites above me.** Share your location, or tap the globe where you are if location access
  isn't available, to see how many satellites are above your horizon and how many are high enough
  (≥ 25°) for a Starlink dish to use. Lines are drawn to each of those.
- **Time controls.** Pause, or speed up to 10×, 60× or 300×, then return to live.

## Run it locally

The site is static: there is no build step. It does need to be served over HTTP, because browsers
block module scripts and web workers on `file://` pages.

```sh
# from the repository root
python3 -m http.server 8000
# then open http://localhost:8000/starlink/
```

## Put it online (GitHub Pages)

1. Merge this branch into `main`.
2. In the repository, open **Settings → Pages**. Under *Build and deployment*, set **Source** to
   **GitHub Actions**.
3. Run the **Deploy Starlink tracker to GitHub Pages** workflow from the *Actions* tab, or push to
   `main`. The tracker is then live at `https://<owner>.github.io/<repo>/starlink/`.

The workflow (`.github/workflows/starlink-pages.yml`) runs every 2 hours. Each run downloads a fresh
snapshot of the orbital elements and publishes it with the site, so visitors load the data from the
site itself. Until Pages is switched on, the workflow skips itself without failing.

Any other static host works too. Without the workflow's snapshot, each visitor's browser downloads
the elements from CelesTrak directly.

## Where the data comes from

Orbital elements are [CelesTrak](https://celestrak.org/)'s GP data for the `starlink` group
(`gp.php?GROUP=starlink&FORMAT=json`). CelesTrak publishes new data every 2 hours and refuses repeat
downloads of unchanged data (HTTP 403), so the page is careful about when it asks:

1. It uses its own copy in the browser if that copy is less than 2 hours old.
2. Otherwise it uses the site's snapshot (`data/starlink.json`, written by the workflow) if that is
   fresh.
3. Otherwise it asks CelesTrak directly. After any error it waits 15 minutes before asking again, or
   2 hours after a 403.
4. If everything fails, it shows the newest data it has, with a notice saying how old it is.

The page uses the JSON (OMM) format rather than classic TLEs. Since July 2026, newly launched
objects have 6-digit catalog numbers, and TLEs can't represent those.

Accuracy: SGP4 on fresh public elements is typically good to a few kilometres. Satellites that are
manoeuvring, such as those raising their orbit, can drift further until their next element set.

## How it's built

| File | Role |
|---|---|
| `index.html`, `styles.css` | Page and HUD layout (works from phone to desktop) |
| `js/app.js` | three.js scene, satellite point cloud, picking, search, time controls, location view |
| `js/propagator.js` | SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) for every satellite, plus orbit and ground-track sampling |
| `js/propagator.worker.js` | Runs the propagator in a web worker; the page runs it itself if a worker can't start |
| `js/data.js` | Loading, caching and fallbacks for the orbital elements |
| `js/earth.js` | Globe texture painted from Natural Earth coastlines, day/night shader, atmosphere, stars |
| `js/astro.js` | Sidereal time, Sun position, shell detection (shared by page and worker) |
| `assets/land-50m.json` | Coastlines ([world-atlas](https://github.com/topojson/world-atlas), from Natural Earth) |

three.js and satellite.js load from the jsDelivr CDN, at pinned versions.

A page that includes `<meta name="starlink-data" content="snapshot-only">` reads only the snapshot
published beside it and never contacts CelesTrak. That's for hosts that block requests to other
sites, such as a sandboxed preview.

## Credits

- Orbital data: [CelesTrak](https://celestrak.org/) (Dr T.S. Kelso).
- SGP4 implementation: [satellite.js](https://github.com/shashwatak/satellite-js) (MIT).
- 3D rendering: [three.js](https://threejs.org/) (MIT).
- Coastlines: [Natural Earth](https://www.naturalearthdata.com/) (public domain), packaged by
  [world-atlas](https://github.com/topojson/world-atlas) (ISC, see `assets/LICENSE-world-atlas.txt`).

Starlink is a trademark of SpaceX. This project is not affiliated with SpaceX.
