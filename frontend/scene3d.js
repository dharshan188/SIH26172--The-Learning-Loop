// ISRO-themed WebGL backdrop: a dotted Earth built from Natural Earth land data
// with India in saffron, a Sriharikota ground-station beacon, gold-foil
// satellites on tilted orbits, periodic launch arcs, and a Moon with an orbiting
// lunar probe. Purely decorative; live telemetry only nudges the beacon and
// uplink through setSceneEnergy().
import * as THREE from 'three';
import {MASK_W, MASK_H, LAND, INDIA} from './earthMask.js';

let energyTarget = 0;
export const setSceneEnergy = value => {energyTarget = Math.max(0, Math.min(1, Number(value) || 0));};

const SAFFRON = 0xff8a1f, CYAN = 0x2fd6ff, GREEN = 0x2ee88a;
const DEG = Math.PI / 180;
const decode = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const land = decode(LAND), india = decode(INDIA);
const maskAt = (bits, lat, lon) => {
  const x = Math.min(MASK_W - 1, Math.floor((lon + 180) / 360 * MASK_W));
  const y = Math.min(MASK_H - 1, Math.floor((90 - lat) / 180 * MASK_H));
  const i = y * MASK_W + x;
  return (bits[i >> 3] >> (7 - (i & 7))) & 1;
};
// Same convention as three.js SphereGeometry UVs, so lon 0 faces +Z.
const latLon = (lat, lon, r) => new THREE.Vector3(r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG), r * Math.cos(lat * DEG) * Math.cos(lon * DEG));

const dotVertex = `
  uniform float uTime; uniform vec3 uHover; uniform float uHoverOn; uniform float uScale;
  attribute float aIndia;
  varying float vIndia; varying float vHover; varying float vFacing;
  void main() {
    vIndia = aIndia;
    vHover = uHoverOn * smoothstep(1.6, 0.0, distance(position, uHover));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = dot(normalize(normalMatrix * position), normalize(-mv.xyz));
    float pulse = aIndia * (0.5 + 0.5 * sin(uTime * 2.0 + position.y * 3.0));
    gl_PointSize = (1.7 + aIndia * 0.9 + pulse * 0.5 + vHover * 2.4) * uScale * (30.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const dotFragment = `
  varying float vIndia; varying float vHover; varying float vFacing;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5 || vFacing < 0.0) discard;
    vec3 col = mix(vec3(0.16, 0.62, 1.0), vec3(1.0, 0.56, 0.14), vIndia);
    col = mix(col, vec3(0.75, 1.0, 1.0), vHover * (1.0 - vIndia));
    float edge = smoothstep(0.0, 0.35, vFacing);
    gl_FragColor = vec4(col, smoothstep(0.5, 0.1, r) * (0.35 + 0.65 * edge) * (0.85 + vHover * 0.4));
  }`;
const atmoVertex = `
  varying vec3 vN; varying vec3 vV;
  void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const atmoFragment = `
  uniform vec3 uColor; uniform float uPower; uniform float uStrength;
  varying vec3 vN; varying vec3 vV;
  void main() { float f = pow(1.0 - abs(dot(vN, vV)), uPower); gl_FragColor = vec4(uColor, f * uStrength); }`;

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d'), g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, '#fff'); g.addColorStop(0.2, 'rgba(255,255,255,.85)'); g.addColorStop(0.5, 'rgba(160,220,255,.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function moonTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8d9097'; ctx.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * 256, y = 10 + Math.random() * 108, r = 1 + Math.random() ** 3 * 14;
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '40,42,50' : '210,212,220'},${0.08 + Math.random() * 0.2})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

// Gold multi-layer-insulation bus, two blue solar wings and an antenna dish.
function makeSatellite(scale = 1) {
  const sat = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({color: 0xd9a441, metalness: 0.85, roughness: 0.35, emissive: 0x3a2400});
  const panelMat = new THREE.MeshStandardMaterial({color: 0x1c3f9e, metalness: 0.5, roughness: 0.3, emissive: 0x08184a, side: THREE.DoubleSide});
  const strut = new THREE.MeshBasicMaterial({color: 0x9fb4c8});
  sat.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.42), gold));
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.02), strut);
    arm.position.x = side * 0.28;
    const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.26), panelMat);
    wing.position.x = side * 0.7;
    wing.rotation.x = Math.PI / 2;
    sat.add(arm, wing);
  }
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({color: 0xeef2f7, metalness: 0.2, roughness: 0.5, side: THREE.DoubleSide}));
  dish.rotation.x = Math.PI;
  dish.position.y = -0.24;
  sat.add(dish);
  sat.scale.setScalar(scale);
  return sat;
}

export function mountScene(canvas) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try {renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'low-power'});}
  catch {canvas.style.display = 'none'; return () => {};}
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
  camera.position.set(0, 0, 30);
  scene.add(new THREE.AmbientLight(0x6f86b0, 0.9));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(-20, 12, 18);
  scene.add(sun);
  const glow = glowTexture();

  // Starfield.
  const starCount = 1600, starPos = new Float32Array(starCount * 3), starCol = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 160 + Math.random() * 160, t = Math.random() * Math.PI * 2, u = Math.acos(2 * Math.random() - 1);
    starPos.set([r * Math.sin(u) * Math.cos(t), r * Math.cos(u), r * Math.sin(u) * Math.sin(t) - 120], i * 3);
    const c = new THREE.Color().setHSL(0.55 + Math.random() * 0.15, 0.6, 0.7 + Math.random() * 0.3);
    starCol.set([c.r, c.g, c.b], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({size: 2, map: glow, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending}));
  scene.add(stars);

  // Earth system: `system` is placed on screen, `earth` spins inside it.
  const R = 5;
  const system = new THREE.Group(), earth = new THREE.Group();
  system.rotation.z = 23.4 * DEG * 0.35;
  system.add(earth);
  scene.add(system);
  earth.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.985, 64, 48), new THREE.MeshBasicMaterial({color: 0x020c1d})));
  const grid = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(R * 0.99, 24, 12)), new THREE.LineBasicMaterial({color: 0x0d3a66, transparent: true, opacity: 0.22}));
  earth.add(grid);

  // Land dots on a Fibonacci sphere, sampled against the land mask.
  const dots = [], indiaFlags = [], N = 26000, golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, lat = Math.asin(y) / DEG, lon = (((i * golden) / DEG) % 360) - 180;
    if (!maskAt(land, lat, lon)) continue;
    const p = latLon(lat, lon, R);
    dots.push(p.x, p.y, p.z);
    indiaFlags.push(maskAt(india, lat, lon));
  }
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
  dotGeo.setAttribute('aIndia', new THREE.Float32BufferAttribute(indiaFlags, 1));
  const dotUniforms = {uTime: {value: 0}, uHover: {value: new THREE.Vector3()}, uHoverOn: {value: 0}, uScale: {value: 1}};
  earth.add(new THREE.Points(dotGeo, new THREE.ShaderMaterial({uniforms: dotUniforms, vertexShader: dotVertex, fragmentShader: dotFragment, transparent: true, depthWrite: false})));

  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.16, 64, 48), new THREE.ShaderMaterial({
    uniforms: {uColor: {value: new THREE.Color(0x2a8cff)}, uPower: {value: 2.6}, uStrength: {value: 0.9}},
    vertexShader: atmoVertex, fragmentShader: atmoFragment, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const rim = new THREE.Mesh(new THREE.SphereGeometry(R * 1.005, 64, 48), new THREE.ShaderMaterial({
    uniforms: {uColor: {value: new THREE.Color(0x58c8ff)}, uPower: {value: 3.5}, uStrength: {value: 0.55}},
    vertexShader: atmoVertex, fragmentShader: atmoFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  system.add(atmo, rim);

  // Sriharikota ground station (SDSC SHAR) with expanding beacon rings.
  const shar = latLon(13.72, 80.23, R * 1.01), sharNormal = shar.clone().normalize();
  const station = new THREE.Group();
  station.position.copy(shar);
  station.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sharNormal);
  const beaconCore = new THREE.Sprite(new THREE.SpriteMaterial({map: glow, color: SAFFRON, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}));
  beaconCore.scale.setScalar(0.9);
  station.add(beaconCore);
  const pulses = [0, 1, 2].map(() => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({color: SAFFRON, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false}));
    station.add(ring);
    return ring;
  });
  earth.add(station);

  // Satellites on tilted orbits; the first one is the uplink partner.
  const orbitDefs = [
    {radius: R * 1.45, tilt: [72 * DEG, 0, 18 * DEG], speed: 0.16, phase: 1.4, color: CYAN, scale: 1},
    {radius: R * 1.75, tilt: [100 * DEG, 0, -32 * DEG], speed: -0.1, phase: 4.2, color: 0x9a7bff, scale: 0.85},
    {radius: R * 2.05, tilt: [86 * DEG, 0, 4 * DEG], speed: 0.065, phase: 2.6, color: GREEN, scale: 0.75},
  ];
  const orbits = orbitDefs.map(def => {
    const plane = new THREE.Group();
    plane.rotation.set(...def.tilt);
    const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.EllipseCurve(0, 0, def.radius, def.radius).getPoints(160)), new THREE.LineDashedMaterial({color: def.color, transparent: true, opacity: 0.35, dashSize: 0.35, gapSize: 0.25}));
    path.computeLineDistances();
    const sat = makeSatellite(def.scale);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({map: glow, color: def.color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false}));
    halo.scale.setScalar(1.6 * def.scale);
    sat.add(halo);
    plane.add(path, sat);
    system.add(plane);
    return {...def, plane, sat};
  });

  // Uplink beam from Sriharikota to the first satellite.
  const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({color: SAFFRON, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}));
  system.add(beam);
  const packet = new THREE.Sprite(new THREE.SpriteMaterial({map: glow, color: 0xffd08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}));
  packet.scale.setScalar(0.7);
  system.add(packet);

  // Launch arc: a rocket climbs from Sriharikota into orbit every few seconds.
  const TRAIL = 48, trailPos = new Float32Array(TRAIL * 3), trailAlpha = new Float32Array(TRAIL);
  for (let i = 0; i < TRAIL; i++) trailAlpha[i] = 1 - i / TRAIL;
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute('aAlpha', new THREE.BufferAttribute(trailAlpha, 1));
  const trailMat = new THREE.ShaderMaterial({
    uniforms: {uOpacity: {value: 0}, uMap: {value: glow}},
    vertexShader: `attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = (1.0 + aAlpha * 5.0) * (30.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uOpacity; uniform sampler2D uMap; varying float vA; void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(mix(vec3(1.0,0.45,0.1), vec3(1.0,0.95,0.8), vA), t.a * vA * uOpacity); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const trail = new THREE.Points(trailGeo, trailMat);
  earth.add(trail);
  const launchStart = shar.clone(), launchUp = sharNormal.clone();
  const launchEast = new THREE.Vector3(0, 1, 0).cross(launchUp).normalize().multiplyScalar(-1);
  const launchPoint = (p, out) => {
    // Gravity turn: rise vertically, then pitch over eastward toward orbit.
    const alt = R * 0.95 * Math.pow(p, 0.75), down = R * 1.4 * p * p;
    return out.copy(launchStart).addScaledVector(launchUp, alt).addScaledVector(launchEast, down).setLength(R + alt);
  };

  // Moon with an orbiting lunar probe, far in the upper left.
  const moonSystem = new THREE.Group();
  const moonTex = moonTexture();
  const moon = new THREE.Mesh(new THREE.SphereGeometry(2.2, 48, 32), new THREE.MeshStandardMaterial({map: moonTex, roughness: 1, metalness: 0}));
  const probe = new THREE.Sprite(new THREE.SpriteMaterial({map: glow, color: 0xffc46b, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}));
  probe.scale.setScalar(0.8);
  const probeOrbit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.EllipseCurve(0, 0, 3.4, 3.4).getPoints(96)), new THREE.LineBasicMaterial({color: 0xffc46b, transparent: true, opacity: 0.25}));
  probeOrbit.rotation.x = 75 * DEG;
  moonSystem.add(moon, probeOrbit, probe);
  scene.add(moonSystem);

  // Pointer: parallax, globe tilt and a highlight on the land under the cursor.
  const pointer = new THREE.Vector2(), smooth = new THREE.Vector2(), ndc = new THREE.Vector2(-9, -9);
  const raycaster = new THREE.Raycaster(), hitSphere = new THREE.Sphere(), hitPoint = new THREE.Vector3();
  const onPointer = event => {
    pointer.set(event.clientX / window.innerWidth * 2 - 1, -(event.clientY / window.innerHeight * 2 - 1));
    ndc.copy(pointer);
  };
  const onLeave = () => ndc.set(-9, -9);
  window.addEventListener('pointermove', onPointer, {passive: true});
  document.addEventListener('pointerleave', onLeave);

  let w = 1, h = 1, ready = false;
  const resize = () => {
    w = window.innerWidth; h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dotUniforms.uScale.value = Math.min(1.4, Math.max(0.8, h / 900)) * Math.min(window.devicePixelRatio || 1, 1.5);
    if (reduced && ready) render();
  };
  resize();
  window.addEventListener('resize', resize);

  // Convert a screen point to the z = 0 world plane.
  const toWorld = (sx, sy, out) => {
    out.set(sx / w * 2 - 1, -(sy / h * 2 - 1), 0.5).unproject(camera).sub(camera.position).normalize();
    return out.multiplyScalar(-camera.position.z / out.z).add(camera.position);
  };
  const target = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const visibleH = () => 2 * camera.position.z * Math.tan(camera.fov * DEG / 2);
  let systemScale = 1;
  const place = () => {
    // A large Earth rising from the lower right corner.
    toWorld(w * (w < 700 ? 0.72 : 0.84), h * 0.98, target);
    system.position.copy(target);
    systemScale = (w < 700 ? 0.85 : 1.1) * visibleH() / (R * 4.3);
    system.scale.setScalar(systemScale);
    // Project onto the z = -40 plane so the Moon lands at this screen point.
    toWorld(w * (w < 700 ? 0.86 : 0.93), h * 0.42, tmp);
    const depth = (camera.position.z + 40) / camera.position.z;
    moonSystem.position.set(camera.position.x + (tmp.x - camera.position.x) * depth, camera.position.y + (tmp.y - camera.position.y) * depth, -40);
    moonSystem.scale.setScalar(w < 700 ? 0.6 : 1);
  };

  const timer = performance.now();
  let frame = 0, running = true, hover = 0, energy = 0;
  const render = () => {
    const t = reduced ? 6 : (performance.now() - timer) / 1000;
    energy += (energyTarget - energy) * 0.06;
    const e = energy;
    smooth.lerp(pointer, 0.05);
    camera.position.x = smooth.x * 0.4;
    camera.position.y = smooth.y * 0.25;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    place();

    // India (≈80°E) drifts around the front, steered by the cursor.
    earth.rotation.y = -80 * DEG + Math.sin(t * 0.08) * 0.55 + smooth.x * 0.12;
    earth.rotation.x = 0.28 - smooth.y * 0.06;
    stars.rotation.y = t * 0.006;
    dotUniforms.uTime.value = t;

    // Cursor highlight on the globe surface.
    raycaster.setFromCamera(ndc, camera);
    hitSphere.set(system.getWorldPosition(tmp), R * systemScale);
    const hit = raycaster.ray.intersectSphere(hitSphere, hitPoint);
    hover += ((hit ? 1 : 0) - hover) * 0.1;
    if (hit) dotUniforms.uHover.value.copy(earth.worldToLocal(hitPoint.clone()));
    dotUniforms.uHoverOn.value = hover;
    atmo.material.uniforms.uStrength.value = 0.9 + hover * 0.35 + e * 0.3;

    // Beacon pulses speed up with live wake-word energy.
    const speed = 0.6 + e * 1.6;
    pulses.forEach((ring, i) => {
      const p = ((t * speed + i / 3) % 1);
      ring.scale.setScalar(0.15 + p * (1.3 + e));
      ring.material.opacity = (1 - p) * (0.55 + e * 0.4);
    });
    beaconCore.material.opacity = 0.75 + Math.sin(t * 4) * 0.15 + e * 0.2;

    orbits.forEach((o, i) => {
      const a = o.phase + t * o.speed;
      o.sat.position.set(Math.cos(a) * o.radius, Math.sin(a) * o.radius, 0);
      o.sat.rotation.z = a + Math.PI / 2;
      o.sat.rotation.x = t * 0.2 + i;
    });

    // Uplink: visible when the partner satellite is above the station's horizon.
    const stationWorld = station.getWorldPosition(tmp);
    const satWorld = orbits[0].sat.getWorldPosition(tmp2);
    const up = stationWorld.clone().sub(system.position).normalize();
    const look = satWorld.clone().sub(stationWorld).normalize();
    const visible = Math.max(0, Math.min(1, (up.dot(look) - 0.05) * 4));
    const sl = system.worldToLocal(stationWorld.clone()), al = system.worldToLocal(satWorld.clone());
    beamGeo.attributes.position.setXYZ(0, sl.x, sl.y, sl.z);
    beamGeo.attributes.position.setXYZ(1, al.x, al.y, al.z);
    beamGeo.attributes.position.needsUpdate = true;
    beam.material.opacity = visible * (0.25 + e * 0.6);
    packet.position.lerpVectors(sl, al, (t * (0.7 + e)) % 1);
    packet.material.opacity = visible * (0.5 + e * 0.5);

    // Launch: 6 s climb, then a pause before the next one.
    const cycle = 11, lt = ((t - 3) % cycle + cycle) % cycle, flight = 6;
    if (lt < flight) {
      for (let i = 0; i < TRAIL; i++) {
        launchPoint(Math.max(0, lt / flight - i * 0.006), tmp);
        trailPos.set([tmp.x, tmp.y, tmp.z], i * 3);
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailMat.uniforms.uOpacity.value = Math.min(1, lt * 3) * Math.min(1, (flight - lt) * 1.5);
    } else trailMat.uniforms.uOpacity.value = 0;

    moon.rotation.y = t * 0.04;
    probe.position.set(Math.cos(t * 0.5) * 3.4, Math.sin(t * 0.5) * 3.4 * Math.cos(75 * DEG), Math.sin(t * 0.5) * 3.4 * Math.sin(75 * DEG));
    renderer.render(scene, camera);
  };
  const loop = () => {if (!running) return; render(); frame = requestAnimationFrame(loop);};
  const onVisibility = () => {
    cancelAnimationFrame(frame);
    running = !document.hidden && !reduced;
    if (running) loop();
  };
  document.addEventListener('visibilitychange', onVisibility);
  render();
  ready = true;
  if (reduced) render(); else loop();

  return () => {
    running = false;
    cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', onVisibility);
    scene.traverse(object => {object.geometry?.dispose(); object.material?.dispose();});
    glow.dispose(); moonTex.dispose();
    renderer.dispose();
  };
}
