// The globe: a coastline texture painted onto a canvas, day/night shading from the real Sun
// direction, an atmosphere rim and a starfield. It has a night-sky look and a daylight look,
// chosen with setTheme('dark' | 'light').
import * as THREE from 'three';

const LAND_URL = new URL('assets/land-50m.json', document.baseURI); // relative to the page

const THEMES = {
  dark: {
    ocean: '#0a1628',
    land: '#1f3550',
    coast: 'rgba(110, 160, 215, 0.55)',
    graticule: 'rgba(120, 165, 225, 0.10)',
    nightMul: [0.45, 0.45, 0.45],
    dayMul: 1.55,
    dayAdd: [0.010, 0.022, 0.040],
    twilight: 0.10,
    rim: [0.20, 0.45, 0.95],
    rimNight: 0.18,
    rimDay: 0.55,
    halo: [0.30, 0.58, 1.0],
    haloStrength: 0.55,
    haloBlending: THREE.AdditiveBlending,
  },
  // Pale "paper globe": light ocean, near-white land, and a cool, soft night side.
  light: {
    ocean: '#c7d7e8',
    land: '#f4f6f9',
    coast: 'rgba(70, 100, 140, 0.55)',
    graticule: 'rgba(60, 90, 130, 0.10)',
    nightMul: [0.70, 0.74, 0.84],
    dayMul: 1.0,
    dayAdd: [0, 0, 0],
    twilight: 0.06,
    rim: [0.30, 0.52, 0.95],
    rimNight: 0.08,
    rimDay: 0.22,
    halo: [0.35, 0.58, 0.95],
    haloStrength: 0.45,
    haloBlending: THREE.NormalBlending,
  },
};

const v3 = (a) => new THREE.Vector3(...a);

export function createEarth(renderer) {
  const group = new THREE.Group();
  let palette = THEMES.dark;
  let topology = null;

  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const width = small || renderer.capabilities.maxTextureSize < 4096 ? 2048 : 4096;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = width / 2;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  const paint = () => {
    paintBase(ctx, canvas.width, canvas.height, palette);
    if (topology) paintLand(ctx, canvas.width, canvas.height, topology, palette);
    texture.needsUpdate = true;
  };

  const sun = new THREE.Vector3(1, 0, 0);
  const surfaceUniforms = {
    uMap: { value: texture },
    uSun: { value: sun },
    uNightMul: { value: v3(palette.nightMul) },
    uDayMul: { value: palette.dayMul },
    uDayAdd: { value: v3(palette.dayAdd) },
    uTwilight: { value: palette.twilight },
    uRim: { value: v3(palette.rim) },
    uRimNight: { value: palette.rimNight },
    uRimDay: { value: palette.rimDay },
  };
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(1, 192, 96),
    new THREE.ShaderMaterial({
      uniforms: surfaceUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vUv = uv;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.0);
          vPosW = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uSun;
        uniform vec3 uNightMul;
        uniform float uDayMul;
        uniform vec3 uDayAdd;
        uniform float uTwilight;
        uniform vec3 uRim;
        uniform float uRimNight;
        uniform float uRimDay;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vec3 n = normalize(vNormalW);
          vec3 base = texture2D(uMap, vUv).rgb;
          float ndl = dot(n, uSun);
          float day = smoothstep(-0.10, 0.16, ndl);
          vec3 color = mix(base * uNightMul, base * uDayMul + uDayAdd, day);
          // Warm band along the terminator.
          color += vec3(0.30, 0.13, 0.04) * exp(-pow(ndl * 9.0, 2.0)) * uTwilight;
          // Atmospheric rim, brighter on the day side.
          vec3 viewDir = normalize(cameraPosition - vPosW);
          float rim = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
          color += uRim * rim * mix(uRimNight, uRimDay, day);
          gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
        }`,
    }),
  );
  surface.name = 'earth';
  group.add(surface);

  // Soft halo outside the limb: added light on the dark theme, a translucent blue on the light one.
  const haloUniforms = { uSun: { value: sun }, uColor: { value: v3(palette.halo) }, uStrength: { value: palette.haloStrength } };
  const haloMaterial = new THREE.ShaderMaterial({
    uniforms: haloUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vPosW = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 n = normalize(vNormalW);
        vec3 viewDir = normalize(cameraPosition - vPosW);
        float facing = max(dot(viewDir, -n), 0.0);
        float glow = pow(smoothstep(0.0, 0.42, facing), 2.0) * (1.0 - smoothstep(0.42, 0.62, facing));
        float day = 0.25 + 0.75 * smoothstep(-0.3, 0.4, dot(n, uSun));
        gl_FragColor = vec4(uColor, glow * day * uStrength);
      }`,
    side: THREE.BackSide,
    blending: palette.haloBlending,
    transparent: true,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(new THREE.SphereGeometry(1.06, 96, 48), haloMaterial));

  paint();
  const ready = fetch(LAND_URL)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data) => {
      topology = data;
      paint();
    })
    .catch((err) => console.warn('Coastlines unavailable:', err));

  return {
    group,
    surface,
    ready,
    /** Sun direction in world (Earth-fixed) coordinates. */
    setSunDirection(v) {
      sun.copy(v);
    },
    /** Switches between the night-sky ('dark') and daylight ('light') looks. */
    setTheme(name) {
      const next = THEMES[name] || THEMES.dark;
      if (next === palette) return;
      palette = next;
      surfaceUniforms.uNightMul.value.set(...palette.nightMul);
      surfaceUniforms.uDayMul.value = palette.dayMul;
      surfaceUniforms.uDayAdd.value.set(...palette.dayAdd);
      surfaceUniforms.uTwilight.value = palette.twilight;
      surfaceUniforms.uRim.value.set(...palette.rim);
      surfaceUniforms.uRimNight.value = palette.rimNight;
      surfaceUniforms.uRimDay.value = palette.rimDay;
      haloUniforms.uColor.value.set(...palette.halo);
      haloUniforms.uStrength.value = palette.haloStrength;
      haloMaterial.blending = palette.haloBlending;
      haloMaterial.needsUpdate = true;
      paint();
    },
  };
}

export function createStarfield(count = 2600) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = 60;
    positions.set([r * s * Math.cos(theta), r * u, r * s * Math.sin(theta)], i * 3);
    const b = 0.35 + rand() * 0.65;
    const tint = rand();
    colors.set([b * (0.85 + 0.15 * tint), b * 0.9, b * (1.0 - 0.12 * tint)], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 1.4,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  return new THREE.Points(geometry, material);
}

function paintBase(ctx, w, h, colors) {
  ctx.fillStyle = colors.ocean;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = colors.graticule;
  ctx.lineWidth = Math.max(1, w / 4096);
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 15) {
    const x = ((lon + 180) / 360) * w;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * h;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

/** Decodes the world-atlas TopoJSON and paints land on an equirectangular canvas. */
function paintLand(ctx, w, h, topology, colors) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  const arcs = topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
  const ringFromArcs = (ids) => {
    const ring = [];
    ids.forEach((id, k) => {
      const arc = id < 0 ? arcs[~id].slice().reverse() : arcs[id];
      for (let i = k ? 1 : 0; i < arc.length; i++) ring.push(arc[i]);
    });
    return ring;
  };

  const rings = [];
  for (const geometry of topology.objects.land.geometries) {
    const polygons = geometry.type === 'Polygon' ? [geometry.arcs] : geometry.arcs;
    for (const polygon of polygons) for (const ids of polygon) rings.push(unwrapRing(ringFromArcs(ids)));
  }

  const px = (lon) => ((lon + 180) / 360) * w;
  const py = (lat) => ((90 - lat) / 180) * h;
  const path = new Path2D();
  for (const ring of rings) {
    // Draw each ring at three horizontal offsets so shapes crossing the antimeridian wrap around.
    for (const offset of [-360, 0, 360]) {
      ring.forEach(([lon, lat], i) => {
        const x = px(lon + offset);
        const y = py(lat);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    }
  }
  ctx.fillStyle = colors.land;
  ctx.fill(path, 'evenodd');
  ctx.strokeStyle = colors.coast;
  ctx.lineWidth = Math.max(1.2, w / 3200);
  ctx.lineJoin = 'round';
  ctx.stroke(path);
}

/**
 * Makes a ring's longitudes continuous (no ±360° jumps). A ring that winds all the way around a pole
 * (Antarctica) is closed along that pole so it fills the right side.
 */
function unwrapRing(ring) {
  const out = [];
  let shift = 0;
  let prev = ring[0][0];
  for (const [lon, lat] of ring) {
    const delta = lon + shift - prev;
    if (delta > 180) shift -= 360;
    else if (delta < -180) shift += 360;
    out.push([lon + shift, lat]);
    prev = lon + shift;
  }
  const winding = out[out.length - 1][0] - out[0][0];
  if (Math.abs(winding) > 300) {
    const meanLat = out.reduce((s, p) => s + p[1], 0) / out.length;
    const pole = meanLat < 0 ? -90 : 90;
    out.push([out[out.length - 1][0], pole], [out[0][0], pole]);
  }
  return out;
}
