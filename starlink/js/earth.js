// The globe: a coastline texture painted onto a canvas, day/night shading from the real Sun
// direction, an atmosphere rim and a starfield.
import * as THREE from 'three';

const LAND_URL = new URL('../assets/land-50m.json', import.meta.url);

const OCEAN = '#0a1628';
const LAND = '#1f3550';
const COAST = 'rgba(110, 160, 215, 0.55)';
const GRATICULE = 'rgba(120, 165, 225, 0.10)';

export function createEarth(renderer) {
  const group = new THREE.Group();

  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const width = small || renderer.capabilities.maxTextureSize < 4096 ? 2048 : 4096;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = width / 2;
  const ctx = canvas.getContext('2d');
  paintBase(ctx, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  const sun = new THREE.Vector3(1, 0, 0);
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(1, 192, 96),
    new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture }, uSun: { value: sun } },
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
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vec3 n = normalize(vNormalW);
          vec3 base = texture2D(uMap, vUv).rgb;
          float ndl = dot(n, uSun);
          float day = smoothstep(-0.10, 0.16, ndl);
          vec3 night = base * 0.45;
          vec3 lit = base * 1.55 + vec3(0.010, 0.022, 0.040);
          vec3 color = mix(night, lit, day);
          // Warm band along the terminator.
          color += vec3(0.30, 0.13, 0.04) * exp(-pow(ndl * 9.0, 2.0)) * 0.10;
          // Atmospheric rim, brighter on the day side.
          vec3 viewDir = normalize(cameraPosition - vPosW);
          float rim = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
          color += vec3(0.20, 0.45, 0.95) * rim * (0.18 + 0.55 * day);
          gl_FragColor = vec4(color, 1.0);
        }`,
    }),
  );
  surface.name = 'earth';
  group.add(surface);

  // Soft halo outside the limb.
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(1.06, 96, 48),
    new THREE.ShaderMaterial({
      uniforms: { uSun: { value: sun } },
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
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vec3 n = normalize(vNormalW);
          vec3 viewDir = normalize(cameraPosition - vPosW);
          float facing = max(dot(viewDir, -n), 0.0);
          float glow = pow(smoothstep(0.0, 0.42, facing), 2.0) * (1.0 - smoothstep(0.42, 0.62, facing));
          float day = 0.25 + 0.75 * smoothstep(-0.3, 0.4, dot(n, uSun));
          gl_FragColor = vec4(vec3(0.30, 0.58, 1.0) * glow * day * 0.55, 1.0);
        }`,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  group.add(halo);

  const ready = fetch(LAND_URL)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((topology) => {
      paintLand(ctx, canvas.width, canvas.height, topology);
      texture.needsUpdate = true;
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

function paintBase(ctx, w, h) {
  ctx.fillStyle = OCEAN;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = GRATICULE;
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
function paintLand(ctx, w, h, topology) {
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
  ctx.fillStyle = LAND;
  ctx.fill(path, 'evenodd');
  ctx.strokeStyle = COAST;
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
