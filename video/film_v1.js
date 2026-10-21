// MARVIN · SIH 2026 film. Every frame is a pure function of time t (seconds),
// so frames can be rendered out of order by parallel workers: renderFrame(t).
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

const W = 1920, H = 1080, V3 = THREE.Vector3;
export const DURATION = 120;

// ---------- timing helpers ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = x => (x = clamp(x), x * x * (3 - 2 * x));
const ease = x => (x = clamp(x), x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = x => 1 - Math.pow(1 - clamp(x), 3);
const prog = (t, a, b) => clamp((t - a) / (b - a));
const frac = x => x - Math.floor(x);
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let r = Math.imul(seed ^ seed >>> 15, 1 | seed);
    r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r;
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}

const COL = {cyan: 0x7ee8ff, violet: 0xb79bff, green: 0x8af0c4, blue: 0x8fb4ff, red: 0xff8a7a, orange: 0xffb47a, saffron: 0xffb366, white: 0xf2faff};

// ---------- renderer ----------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x13294f);
scene.fog = new THREE.FogExp2(0x13294f, 0.0085);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 1500);
const QS = new URLSearchParams(location.search);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, {type: THREE.HalfFloatType, samples: +(QS.get('msaa') ?? 4)}));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.42, 0.4, 0.82);
if (!QS.has('nobloom')) composer.addPass(bloom);
composer.addPass(new OutputPass());
const POINT_SCALE = H / (2 * Math.tan(THREE.MathUtils.degToRad(42) / 2));

// ---------- shared materials & textures ----------
const ADD = {transparent: true, depthWrite: false, blending: THREE.AdditiveBlending};
const basic = (color, opacity = 1, extra = {}) => new THREE.MeshBasicMaterial({color, opacity, side: THREE.DoubleSide, ...ADD, ...extra});
const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({color, opacity, ...ADD});

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const glowTex = canvasTexture(128, 128, (x) => {
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.18, 'rgba(255,255,255,.75)');
  g.addColorStop(.48, 'rgba(255,255,255,.16)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
});
glowTex.colorSpace = THREE.NoColorSpace;
const glowSprite = (color, scale, opacity = 1) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTex, color, opacity: opacity * .55, ...ADD}));
  s.scale.setScalar(scale);
  return s;
};

// Particle system with per-point color, alpha and world-space size.
const pointsVS = `attribute vec3 aColor; attribute float aAlpha; attribute float aSize; uniform float uScale;
varying vec3 vColor; varying float vA;
void main(){ vColor=aColor; vA=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.0);
  gl_PointSize=max(1.0, aSize*uScale/-mv.z); gl_Position=projectionMatrix*mv; }`;
const pointsFS = `uniform sampler2D uTex; uniform float uAlpha; varying vec3 vColor; varying float vA;
void main(){ vec4 tx=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vColor, tx.a*vA*uAlpha); }`;
function makePoints(n) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), al = new Float32Array(n).fill(1), sz = new Float32Array(n).fill(.3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  const mat = new THREE.ShaderMaterial({uniforms: {uTex: {value: glowTex}, uAlpha: {value: 1}, uScale: {value: POINT_SCALE}},
    vertexShader: pointsVS, fragmentShader: pointsFS, ...ADD});
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const color = new THREE.Color();
  return {
    points, pos, col, al, sz, n,
    setColor(i, hex, mul = 1) {color.set(hex); col[i * 3] = color.r * mul; col[i * 3 + 1] = color.g * mul; col[i * 3 + 2] = color.b * mul;},
    commit() {for (const k of ['position', 'aColor', 'aAlpha', 'aSize']) geo.attributes[k].needsUpdate = true;},
  };
}

// Group opacity: each material keeps its authored opacity (base) and an optional
// per-frame factor (userData.k) set by scene updates.
function setAlpha(obj, a) {
  obj.visible = a > 0.003;
  if (!obj.visible) return;
  obj.traverse(o => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.userData.base === undefined) {m.userData.base = m.opacity; m.transparent = true;}
      const v = m.userData.base * a * (m.userData.k ?? 1);
      if (m.uniforms?.uAlpha) m.uniforms.uAlpha.value = a * (m.userData.k ?? 1);
      else m.opacity = v;
    }
  });
}
const factor = (mesh, k) => {(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => {m.userData.k = k;});};

const anchors = {};
const anchor = (group, name, x, y, z) => {const o = new THREE.Object3D(); o.position.set(x, y, z); group.add(o); anchors[name] = o; return o;};

// ---------- persistent background ----------
const stars = makePoints(2600);
{
  const r = rng(3);
  for (let i = 0; i < stars.n; i++) {
    const rad = 380 + r() * 300, th = r() * Math.PI * 2, ph = Math.acos(2 * r() - 1);
    stars.pos.set([rad * Math.sin(ph) * Math.cos(th), rad * Math.cos(ph) * .8 + 60, rad * Math.sin(ph) * Math.sin(th)], i * 3);
    stars.setColor(i, [0xbfe6ff, 0x9fb7ff, 0xffffff, 0xc7a8ff][i % 4]);
    stars.sz[i] = 1.2 + r() * 2.6;
    stars.al[i] = .35 + r() * .65;
  }
  stars.commit();
  stars.points.material.fog = false;
  scene.add(stars.points);
}
const starBase = Float32Array.from(stars.al);

const dust = makePoints(3200);
const dustPhase = new Float32Array(dust.n);
{
  const r = rng(5);
  for (let i = 0; i < dust.n; i++) {
    dust.pos.set([(r() - .5) * 200, (r() - .5) * 90 + 6, 90 - r() * 1260], i * 3);
    dust.setColor(i, r() > .7 ? COL.violet : 0x6fd8ff, .8);
    dust.sz[i] = .12 + r() * .3;
    dustPhase[i] = r() * 6.28;
  }
  scene.add(dust.points);
}

const nebulae = new THREE.Group();
{
  const r = rng(9);
  for (let i = 0; i < 14; i++) {
    const s = glowSprite([0x1d3cff, 0x6a2bff, 0x0a8cff, 0x3a1580][i % 4], 160 + r() * 140, .16);
    s.position.set((r() - .5) * 320, (r() - .2) * 90, 40 - i * 90 - 120);
    nebulae.add(s);
  }
  scene.add(nebulae);
}

// Flowing particle terrain under every scene (moves with the camera, pattern fixed in world).
const terrainUniforms = {uTime: {value: 0}, uOffset: {value: 0}, uAlpha: {value: 1}, uScale: {value: POINT_SCALE}};
const terrain = (() => {
  const cols = 200, rows = 90, pos = new Float32Array(cols * rows * 3), seed = new Float32Array(cols * rows), r = rng(21);
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const i = z * cols + x;
    pos.set([(x / (cols - 1) - .5) * 220, 0, -z * 1.6 + 30], i * 3);
    seed[i] = r();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({uniforms: {...terrainUniforms, uTex: {value: glowTex}}, ...ADD,
    vertexShader: `uniform float uTime; uniform float uOffset; uniform float uScale; attribute float aSeed; varying float vH; varying float vF;
      void main(){ vec3 p=position; float wz=p.z+uOffset;
        p.y += sin(p.x*.09+uTime*.6)*1.4 + sin(wz*.13-uTime*.8)*1.1 + sin((p.x+wz)*.05+uTime*.35)*1.8;
        vH=p.y; vec4 mv=modelViewMatrix*vec4(p,1.0);
        vF=smoothstep(-150.0,-30.0,mv.z)*(1.0-smoothstep(-14.0,-4.0,mv.z));
        gl_PointSize=(.16+aSeed*.14)*uScale/-mv.z; gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D uTex; uniform float uAlpha; varying float vH; varying float vF;
      void main(){ float a=texture2D(uTex,gl_PointCoord).a; vec3 c=mix(vec3(.45,.25,1.),vec3(.0,.75,1.),smoothstep(-3.,3.,vH));
        gl_FragColor=vec4(c, a*vF*.55*uAlpha); }`});
  mat.uniforms = Object.assign(mat.uniforms, terrainUniforms);
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  if (!QS.has('noterrain')) scene.add(pts);
  return pts;
})();

// ---------- reusable pieces ----------
function makeOrb() {
  const g = new THREE.Group();
  const halo = glowSprite(0x6f9dff, 16, .6);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2, 3), basic(0x37d8ff, .3, {wireframe: true}));
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), basic(0xa77bff, .7, {wireframe: true}));
  const heart = new THREE.Mesh(new THREE.SphereGeometry(.7, 32, 16), basic(0xbfe9ff, .55));
  const heartGlow = glowSprite(0x7fe9ff, 6, .9);
  g.add(halo, shell, core, heart, heartGlow);
  const rings = [COL.cyan, COL.violet, COL.green].map((c, i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(4.7 + i * 1.05, .035, 8, 240), basic(c, .8));
    g.add(m);
    return m;
  });
  const waves = [0, 1, 2].map(() => {const m = new THREE.Mesh(new THREE.RingGeometry(1, 1.02, 160), basic(0x5fe6ff, .22)); g.add(m); return m;});
  return {group: g, update(t, energy = 0) {
    shell.rotation.set(t * .15, t * .22, 0);
    core.rotation.set(-t * .5, t * .35, 0);
    shell.scale.setScalar(1 + Math.sin(t * 2.4) * .035 + energy * .18);
    heart.scale.setScalar(.92 + Math.sin(t * 3) * .07 + energy * .45);
    factor(heartGlow, .8 + energy * .8);
    rings.forEach((m, i) => m.rotation.set(1.18 + i * .36 + Math.sin(t * .3 + i) * .1, i * .7 + t * (.2 + i * .08) * (i % 2 ? -1 : 1), 0));
    waves.forEach((w, i) => {
      const k = frac(t * .45 + i / 3);
      w.scale.setScalar(3.4 + k * 15);
      w.quaternion.copy(camera.quaternion);
      factor(w, Math.pow(1 - k, 2) * (1 + energy));
    });
  }};
}

function panelTexture(num, title, sub, accent) {
  return canvasTexture(1024, 600, (x, w, h) => {
    const r = 46;
    x.beginPath(); x.roundRect(8, 8, w - 16, h - 16, r);
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(26,52,96,0.92)'); g.addColorStop(1, 'rgba(18,36,74,0.92)');
    x.fillStyle = g; x.fill();
    x.lineWidth = 6; x.strokeStyle = accent; x.stroke();
    x.fillStyle = accent; x.font = '600 50px "Space Grotesk"'; x.fillText(num, 64, 128);
    x.fillRect(64, 154, 90, 6);
    x.fillStyle = '#ffffff'; x.font = '700 96px "Space Grotesk"'; x.fillText(title, 64, 300);
    x.fillStyle = '#dbe8f5'; x.font = '400 50px Inter'; x.fillText(sub, 64, 400);
    if (sub.length > 30) {/* keep within card */}
  });
}

// ---------- scene 0 · opening ----------
function buildIntro() {
  const g = new THREE.Group(), orb = makeOrb();
  g.add(orb.group);
  const N = 2400, P = makePoints(N), r = rng(11);
  const start = new Float32Array(N * 3), target = new Float32Array(N * 3), delay = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + .5) / N * 2, rad = Math.sqrt(1 - y * y), th = i * 2.39996, R = 8.6 + r() * 1.8;
    target.set([Math.cos(th) * rad * R, y * R, Math.sin(th) * rad * R], i * 3);
    const d = new V3(r() - .5, r() - .5, r() - .5).normalize().multiplyScalar(45 + r() * 60);
    start.set([d.x, d.y, d.z], i * 3);
    delay[i] = r();
    P.sz[i] = .1 + r() * .22;
    P.setColor(i, r() > .65 ? COL.violet : r() > .5 ? 0xffffff : COL.cyan);
  }
  g.add(P.points);
  return {group: g, update(lt) {
    const energy = Math.exp(-Math.pow(lt - 2.6, 2) / .35) * 1.2 + Math.exp(-Math.pow(lt - 3.9, 2) / .5) * .5;
    orb.update(lt, energy);
    for (let i = 0; i < N; i++) {
      const k = 1 - Math.pow(1 - prog(lt, .1 + delay[i] * 1.6, 3.3 + delay[i] * 1.6), 4);
      for (let a = 0; a < 3; a++) P.pos[i * 3 + a] = lerp(start[i * 3 + a], target[i * 3 + a], k);
      P.al[i] = (.2 + .8 * k) * (.75 + .25 * Math.sin(lt * 3 + i));
    }
    P.points.rotation.y = lt * .07;
    P.commit();
  }};
}

// ---------- scene 1 · problem ----------
function buildProblem() {
  const g = new THREE.Group();
  const dev = new THREE.Group();
  dev.position.set(-6, -1.6, 0);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.3, 5.2, 72), new THREE.MeshStandardMaterial({color: 0x1a2536, metalness: .55, roughness: .38, envMapIntensity: .9}));
  dev.add(body);
  for (let i = 0; i < 6; i++) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(2.08 + i * .045, .025, 6, 96), basic(0x2b4766, .7));
    band.rotation.x = Math.PI / 2;
    band.position.y = -1.9 + i * .62;
    dev.add(band);
  }
  const topRing = new THREE.Mesh(new THREE.TorusGeometry(1.75, .1, 12, 120), basic(COL.red, 1));
  topRing.rotation.x = Math.PI / 2; topRing.position.y = 2.62;
  const topGlow = glowSprite(COL.red, 6, .9);
  topGlow.position.y = 2.8;
  dev.add(topRing, topGlow);
  const waves = [0, 1, 2].map(() => {const m = new THREE.Mesh(new THREE.RingGeometry(1, 1.04, 128), basic(COL.red, .6)); m.rotation.x = -Math.PI / 2; m.position.y = 2.65; dev.add(m); return m;});
  g.add(dev);

  const cloud = new THREE.Group();
  cloud.position.set(10, 4, -4);
  for (const [x, y, z, rad] of [[0, 0, 0, 3], [2.9, -.6, .3, 2.3], [-2.9, -.7, .2, 2.2], [1.3, 1.7, -.2, 2.2], [-1.4, 1.3, .1, 2]]) {
    const fill = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 3), basic(0x4c86ff, .06));
    const wire = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 2), basic(0x6aa8ff, .26, {wireframe: true}));
    fill.position.set(x, y, z); wire.position.set(x, y, z);
    cloud.add(fill, wire);
  }
  cloud.add(glowSprite(0x3a6bff, 16, .45));
  g.add(cloud);

  const curve = new THREE.CubicBezierCurve3(new V3(-6, 1.3, 0), new V3(-3, 10, 1), new V3(4.5, 11, -3), new V3(9.6, 4.3, -4));
  const N = 700, S = makePoints(N), r = rng(13), seed = new Float32Array(N), off = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    seed[i] = r();
    off.set([r() - .5, r() - .5, r() - .5], i * 3);
    S.sz[i] = .14 + r() * .26;
    S.setColor(i, r() > .5 ? COL.orange : COL.red);
  }
  g.add(S.points);
  const packets = Array.from({length: 9}, (_, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(.6, .6, .6), basic(COL.orange, .8, {wireframe: true}));
    g.add(m);
    return m;
  });

  const bat = new THREE.Group();
  bat.position.set(-1.6, -3.4, 3.2);
  const shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.5, 3, .9)), lineMat(0xffd0c8, .8));
  const cap = new THREE.Mesh(new THREE.BoxGeometry(.6, .25, .5), basic(0xffd0c8, .8));
  cap.position.y = 1.63;
  const fill = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.7, .62), basic(COL.green, .45));
  bat.add(shell, cap, fill);
  g.add(bat);

  anchor(g, 'p-cloud', 10, 8.6, -4);
  const streamPin = anchor(g, 'p-stream', 0, 0, 0);
  streamPin.position.copy(curve.getPoint(.5)).add(new V3(0, 1.6, 0));
  anchor(g, 'p-battery', -1.6, -4.9, 3.2);

  const red = new THREE.Color(COL.red), green = new THREE.Color(COL.green), tmp = new V3();
  return {group: g, update(lt) {
    factor(topRing, .7 + .3 * Math.sin(lt * 6));
    waves.forEach((w, i) => {const k = frac(lt * .6 + i / 3); w.scale.setScalar(2 + k * 8); factor(w, Math.pow(1 - k, 2));});
    cloud.position.y = 4 + Math.sin(lt * .7) * .3;
    cloud.rotation.y = Math.sin(lt * .2) * .2;
    for (let i = 0; i < N; i++) {
      const u = frac(seed[i] + lt * .26), spread = Math.sin(u * Math.PI) * 1.4;
      curve.getPoint(u, tmp);
      S.pos[i * 3] = tmp.x + off[i * 3] * spread;
      S.pos[i * 3 + 1] = tmp.y + off[i * 3 + 1] * spread;
      S.pos[i * 3 + 2] = tmp.z + off[i * 3 + 2] * spread;
      S.al[i] = Math.pow(Math.sin(u * Math.PI), .5);
    }
    S.commit();
    packets.forEach((m, i) => {
      const u = frac(i / packets.length + lt * .14);
      curve.getPoint(u, m.position);
      m.rotation.set(lt * 1.3 + i, lt * .9 + i * 2, 0);
      factor(m, Math.sin(u * Math.PI));
    });
    const level = lerp(.95, .1, ease(prog(lt, 1.5, 12.5)));
    fill.scale.y = level;
    fill.position.y = -1.35 + 1.35 * level;
    fill.material.color.copy(red).lerp(green, clamp((level - .1) / .7));
    factor(fill, level < .25 ? .55 + .45 * Math.abs(Math.sin(lt * 5)) : 1);
  }};
}

// ---------- scene 2 · solution (ESP32 + INMP441) ----------
function buildSolution() {
  const g = new THREE.Group();
  const lights = [new THREE.AmbientLight(0x6688aa, .5), new THREE.DirectionalLight(0xffffff, .9), new THREE.PointLight(COL.cyan, 30, 40), new THREE.PointLight(COL.violet, 30, 40)];
  lights[1].position.set(5, 12, 8); lights[2].position.set(-6, 5, 5); lights[3].position.set(9, 3, -5);
  g.add(...lights);

  const board = new THREE.Group();
  const std = (color, metalness = .2, roughness = .6) => new THREE.MeshStandardMaterial({color, metalness, roughness});
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(7.2, .16, 3.2), std(0x0c1d2b, .25, .55));
  board.add(pcb, new THREE.LineSegments(new THREE.EdgesGeometry(pcb.geometry), lineMat(0x2bd8ff, .65)));
  {
    const r = rng(7), seg = [];
    for (let i = 0; i < 60; i++) {
      const x0 = -3.3 + r() * 4.6, z0 = -1.3 + r() * 2.6, len = .3 + r() * 1.3;
      if (r() > .5) seg.push(x0, .085, z0, Math.min(x0 + len, 3.4), .085, z0);
      else seg.push(x0, .085, z0, x0, .085, clamp(z0 + (r() > .5 ? len : -len) * .6, -1.4, 1.4));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    board.add(new THREE.LineSegments(geo, lineMat(0x1f7fa6, .7)));
  }
  const mod = new THREE.Mesh(new THREE.BoxGeometry(2.7, .1, 3.0), std(0x112538));
  mod.position.set(2.05, .13, 0);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(2.4, .34, 2.25), std(0x7d8892, 1, .38));
  shield.position.set(1.62, .35, 0);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.15), new THREE.MeshStandardMaterial({color: 0x9aa4ad, metalness: .5, roughness: .45, map: canvasTexture(512, 480, (x, w, h) => {
    const gr = x.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#dfe6ec'); gr.addColorStop(1, '#aab6c0');
    x.fillStyle = gr; x.fillRect(0, 0, w, h);
    x.fillStyle = '#3d4a55'; x.font = '600 36px "Space Grotesk"'; x.fillText('ESPRESSIF', 40, 90);
    x.font = '700 50px "Space Grotesk"'; x.fillText('ESP32-WROOM-32', 40, 200);
    x.font = '400 30px Inter'; x.fillText('Wi-Fi · Bluetooth · 240 MHz', 40, 270);
    x.strokeStyle = '#6b7884'; x.lineWidth = 3; x.strokeRect(40, 320, 120, 120);
  })}));
  label.rotation.x = -Math.PI / 2; label.position.set(1.62, .525, 0);
  const antenna = [];
  for (let i = 0; i <= 10; i++) antenna.push(new V3(3.05 + (i % 2) * .28, .19, -1.25 + i * .25));
  const ant = new THREE.Line(new THREE.BufferGeometry().setFromPoints(antenna), lineMat(0xffc65c, 1));
  board.add(mod, shield, label, ant);
  const usb = new THREE.Mesh(new THREE.BoxGeometry(.95, .4, .85), std(0x6f7a84, 1, .45));
  usb.position.set(-3.35, .28, 0);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(.75, .12, .75), std(0x0b0d10, .1, .45));
  bridge.position.set(-1.9, .14, .45);
  const reg = new THREE.Mesh(new THREE.BoxGeometry(.5, .16, .35), std(0x0b0d10, .1, .45));
  reg.position.set(-2.4, .15, -.8);
  board.add(usb, bridge, reg);
  for (const z of [1.05, -1.05]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(.45, .2, .4), std(0x6f7a84, .8, .45));
    b.position.set(-2.85, .18, z);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, .12, 20), std(0x111111));
    cap.position.set(-2.85, .32, z);
    board.add(b, cap);
  }
  const led = new THREE.Mesh(new THREE.BoxGeometry(.18, .1, .12), basic(0x3aa0ff, 1));
  led.position.set(-1.1, .13, -1.12);
  const ledGlow = glowSprite(0x3aa0ff, 1.2, .9);
  ledGlow.position.copy(led.position);
  board.add(led, ledGlow);
  const pinMat = std(0xe0b45a, 1, .3);
  const pins = new THREE.InstancedMesh(new THREE.CylinderGeometry(.045, .045, .9, 8), pinMat, 38);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 38; i++) {m4.makeTranslation(-3.15 + (i % 19) * .35, -.6, i < 19 ? 1.42 : -1.42); pins.setMatrixAt(i, m4);}
  board.add(pins);
  for (const z of [1.42, -1.42]) {
    const hdr = new THREE.Mesh(new THREE.BoxGeometry(6.8, .26, .3), std(0x111418, .1, .7));
    hdr.position.set(0, -.21, z);
    board.add(hdr);
  }
  g.add(board);

  const mic = new THREE.Group();
  const micPcb = new THREE.Mesh(new THREE.CylinderGeometry(.9, .9, .08, 48), std(0x2b1a66, .2, .5));
  const can = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, .26, 32), std(0xd0d8de, 1, .25));
  can.position.y = .17;
  const hole = new THREE.Mesh(new THREE.CircleGeometry(.07, 20), basic(0x111111, 1, {blending: THREE.NormalBlending}));
  hole.rotation.x = -Math.PI / 2; hole.position.y = .305;
  mic.add(micPcb, can, hole, new THREE.LineSegments(new THREE.EdgesGeometry(micPcb.geometry), lineMat(COL.violet, .8)));
  const micGlow = glowSprite(COL.violet, 3, .5);
  mic.add(micGlow);
  g.add(mic);
  const wireMats = [0xc8323f, 0xc9a23e, 0x2a7fc0].map(c => std(c, .1, .6));
  const wires = wireMats.map(m => {const w = new THREE.Mesh(new THREE.BufferGeometry(), m); g.add(w); return w;});

  // Tiny neural network hovering over the chip.
  const net = new THREE.Group();
  const layers = [4, 7, 7, 3], nodes = [];
  layers.forEach((n, li) => {for (let k = 0; k < n; k++) nodes.push({li, p: new V3((li - 1.5) * 1.35, (k - (n - 1) / 2) * .62, 0)});});
  const NP = makePoints(nodes.length);
  nodes.forEach((nd, i) => {NP.pos.set([nd.p.x, nd.p.y, 0], i * 3); NP.sz[i] = .55; NP.setColor(i, nd.li === 3 ? COL.green : nd.li % 2 ? COL.violet : COL.cyan);});
  NP.commit();
  const edges = [];
  for (let a = 0; a < nodes.length; a++) for (let b = 0; b < nodes.length; b++) if (nodes[b].li === nodes[a].li + 1) edges.push([a, b]);
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(edges.flatMap(([a, b]) => [...nodes[a].p.toArray(), ...nodes[b].p.toArray()]), 3));
  net.add(new THREE.LineSegments(eg, lineMat(0x59c8ff, .22)), NP.points);
  const sparks = makePoints(60), sr = rng(17), sparkEdge = [], sparkPhase = [];
  for (let i = 0; i < 60; i++) {sparkEdge.push(Math.floor(sr() * edges.length)); sparkPhase.push(sr()); sparks.sz[i] = .3; sparks.setColor(i, 0xffffff);}
  net.add(sparks.points);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(.25, 2.4, 3.3, 48, 1, true), basic(COL.cyan, .045));
  beam.position.y = -2.4;
  net.add(beam);
  g.add(net);

  const espPin = anchor(g, 's-esp', 0, 0, 0), micPin = anchor(g, 's-mic', 0, 0, 0), netPin = anchor(g, 's-net', 0, 0, 0);
  const tmp = new V3();
  return {group: g, update(lt) {
    const rise = easeOut(prog(lt, 0, 2.2));
    board.position.set(2.2, -1.2 + Math.sin(lt * .8) * .12 - (1 - rise) * 3, 0);
    board.rotation.set(.12, -.5 + lt * .045, 0);
    mic.position.set(-3.2 + Math.sin(lt * .7) * .1, 1.5 + Math.sin(lt * .9) * .15 - (1 - rise) * 2, 3.4);
    mic.rotation.set(.5, lt * .3, -.25);
    factor(micGlow, .6 + .4 * Math.sin(lt * 4));
    board.updateMatrix(); mic.updateMatrix();
    wires.forEach((w, i) => {
      const a = new V3(-.3 + i * .3, -.05, .55).applyMatrix4(mic.matrix);
      const b = new V3(-2.6 + i * .35, .1, 1.42).applyMatrix4(board.matrix);
      const c = new THREE.CatmullRomCurve3([a, a.clone().add(new V3(0, -1.2, 0)), b.clone().add(new V3(0, .9, .3)), b]);
      w.geometry.dispose();
      w.geometry = new THREE.TubeGeometry(c, 40, .05, 8, false);
    });
    net.position.set(board.position.x + .4, 3.9 + Math.sin(lt * .9) * .15, -.2);
    net.rotation.y = -.25 + Math.sin(lt * .3) * .12;
    const netOn = prog(lt, 1.2, 3);
    factor(net.children[0], netOn);
    for (let i = 0; i < 60; i++) {
      const [a, b] = edges[sparkEdge[i]], u = frac(sparkPhase[i] + lt * .8);
      tmp.copy(nodes[a].p).lerp(nodes[b].p, u);
      sparks.pos.set([tmp.x, tmp.y, .02], i * 3);
      sparks.al[i] = Math.sin(u * Math.PI) * netOn;
    }
    sparks.commit();
    for (let i = 0; i < nodes.length; i++) NP.al[i] = netOn * (.7 + .3 * Math.sin(lt * 3 + i));
    NP.commit();
    espPin.position.set(board.position.x + 1.4, board.position.y + 1.25, .3);
    micPin.position.set(mic.position.x, mic.position.y + 1.1, mic.position.z);
    netPin.position.set(net.position.x, net.position.y + 2.7, net.position.z);
  }};
}

// ---------- scene 3 · pipeline ----------
const PIPE_STEP = 4.8;
const pipeX = [-26, -13, 0, 13, 26], pipeZ = [0, -1.5, 0, -1.5, 0];
const pipeFocus = lt => {
  const k = clamp(Math.floor(lt / PIPE_STEP), 0, 4);
  if (k >= 4) return pipeX[4];
  return lerp(pipeX[k], pipeX[k + 1], ease(prog(lt, (k + 1) * PIPE_STEP - 1.3, (k + 1) * PIPE_STEP)));
};
function buildPipeline() {
  const g = new THREE.Group();
  const defs = [['01', 'MICROPHONE', 'INMP441 · 16 kHz', '#9eefff', COL.cyan], ['02', 'FEATURES', 'Log-Mel spectrogram', '#9eefff', COL.cyan],
    ['03', 'STAGE 1', 'Keyword spotter', '#9eefff', COL.cyan], ['04', 'STAGE 2', 'Temporal verifier', '#d2bcff', COL.violet], ['05', 'CLOUD ASR', 'Speech → text', '#a8f7d4', COL.green]];
  const panels = defs.map(([num, title, sub, css, hex], i) => {
    const p = new THREE.Group();
    p.position.set(pipeX[i], -.6, pipeZ[i]);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 4.92), new THREE.MeshBasicMaterial({color: new THREE.Color(.8, .8, .8), map: panelTexture(num, title, sub, css), transparent: true, depthWrite: false}));
    const slab = new THREE.Mesh(new THREE.BoxGeometry(8.4, 4.92, .35), basic(hex, .05));
    slab.position.z = -.2;
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), lineMat(hex, .9));
    edge.position.z = -.2;
    const glow = glowSprite(hex, 14, .14);
    glow.position.z = -1;
    p.add(glow, slab, edge, face);
    g.add(p);
    return {p, edge, glow, face};
  });

  // Waveform above the microphone.
  const WN = 520, wave = makePoints(WN);
  for (let i = 0; i < WN; i++) {wave.sz[i] = .2; wave.setColor(i, i % 3 ? COL.cyan : 0xffffff);}
  g.add(wave.points);

  // Spectrogram bars above the feature extractor.
  const SC = 28, SR = 12, spec = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({transparent: true, opacity: .92}), SC * SR);
  g.add(spec);
  const specFrame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(7.4, .05, 3.4)), lineMat(COL.cyan, .5));
  specFrame.position.set(pipeX[1], 3.85, pipeZ[1]);
  g.add(specFrame);

  const icons = [
    [2, new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), basic(COL.cyan, .8, {wireframe: true})), new THREE.Mesh(new THREE.OctahedronGeometry(.7, 0), basic(0xbff6ff, .5))],
    [3, new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 1), basic(COL.violet, .8, {wireframe: true})), new THREE.Mesh(new THREE.IcosahedronGeometry(.7, 0), basic(0xe2d0ff, .5))],
  ].map(([i, outer, inner]) => {
    const grp = new THREE.Group();
    grp.position.set(pipeX[i], 5.6, pipeZ[i]);
    grp.add(outer, inner, glowSprite(i === 2 ? COL.cyan : COL.violet, 6, .5));
    g.add(grp);
    return {grp, outer, inner};
  });
  const cloud = new THREE.Group();
  cloud.position.set(pipeX[4], 5.5, pipeZ[4]);
  for (const [x, y, rad] of [[0, 0, 1.5], [1.4, -.35, 1.1], [-1.4, -.4, 1.05], [.6, .85, 1.05]]) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 2), basic(COL.green, .35, {wireframe: true}));
    m.position.set(x, y, 0);
    cloud.add(m);
  }
  cloud.add(glowSprite(COL.green, 7, .45));
  g.add(cloud);

  // Particle flow: noise dies at Stage 1, near-misses die at Stage 2, wake words reach the cloud.
  const path = new THREE.CatmullRomCurve3([new V3(-31, 2.7, .4), ...pipeX.map((x, i) => new V3(x, 2.7, pipeZ[i] + .4))]);
  const uNode = pipeX.map(x => (x + 31) / 57);
  const FN = 1100, F = makePoints(FN), fr = rng(29), fSeed = new Float32Array(FN), fCls = new Uint8Array(FN), fOff = new Float32Array(FN * 2);
  for (let i = 0; i < FN; i++) {
    fSeed[i] = fr();
    const c = fr();
    fCls[i] = c < .72 ? 0 : c < .9 ? 1 : 2;
    fOff[i * 2] = fr() - .5; fOff[i * 2 + 1] = fr() - .5;
    F.sz[i] = fCls[i] === 2 ? .3 : .17 + fr() * .1;
  }
  g.add(F.points);
  const burst = new THREE.Mesh(new THREE.RingGeometry(1, 1.06, 128), basic(COL.green, .9));
  burst.position.set(pipeX[3] + 4.5, 2.7, pipeZ[3] + .4);
  g.add(burst);

  const tmp = new V3(), color = new THREE.Color(), cCyan = new THREE.Color(COL.cyan), cViolet = new THREE.Color(COL.violet), cGreen = new THREE.Color(COL.green), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3();
  return {group: g, update(lt) {
    const fx = pipeFocus(lt);
    panels.forEach(({p, edge, glow, face}, i) => {
      const f = 1 - clamp(Math.abs(fx - pipeX[i]) / 13);
      p.scale.setScalar(1 + f * .05);
      factor(edge, .35 + .65 * f);
      factor(glow, .3 + 1.2 * f);
      factor(face, .55 + .45 * f);
    });
    for (let i = 0; i < WN; i++) {
      const u = i / (WN - 1), x = lerp(-30, -22, u);
      const env = Math.sin(u * Math.PI) * (.55 + .45 * Math.sin(lt * 1.7 + u * 4));
      const y = env * (Math.sin(u * 60 + lt * 9) * .9 + Math.sin(u * 23 - lt * 5) * .6 + Math.sin(u * 131 + lt * 13) * .25);
      wave.pos.set([x, 5.4 + y, pipeZ[0] + (i % 3) * .05], i * 3);
      wave.al[i] = .9;
    }
    wave.commit();
    let k = 0;
    for (let c = 0; c < SC; c++) for (let r = 0; r < SR; r++, k++) {
      const sc = c - lt * 7, burstAmt = Math.max(0, Math.sin(sc * .32)) * (.55 + .45 * Math.sin(sc * .09 + 1.3));
      const band = Math.exp(-Math.pow(r - 4 - 2.5 * Math.sin(sc * .21), 2) / 7) + .35 * Math.exp(-Math.pow(r - 9, 2) / 3);
      const h = .08 + 2.3 * burstAmt * band + .1 * frac(Math.sin(c * 12.9898 + r * 78.233 + Math.floor(lt * 8)) * 43758.5453);
      s.set(.2, h, .2);
      m4.compose(tmp.set(pipeX[1] - 3.4 + c * (6.8 / (SC - 1)), 3.9 + h / 2, pipeZ[1] - 1.5 + r * (3 / (SR - 1))), q, s);
      spec.setMatrixAt(k, m4);
      const e = clamp(h / 2.2);
      color.setRGB(lerp(.05, .75, e * e), lerp(.25, 1, e), 1).multiplyScalar(.4 + e * .45);
      spec.setColorAt(k, color);
    }
    spec.instanceMatrix.needsUpdate = true;
    spec.instanceColor.needsUpdate = true;
    icons.forEach(({grp, outer, inner}, i) => {
      outer.rotation.set(lt * .5, lt * .7 * (i ? -1 : 1), 0);
      inner.rotation.set(-lt, lt * .8, 0);
      grp.position.y = 5.6 + Math.sin(lt * 1.2 + i) * .2;
    });
    cloud.rotation.y = lt * .3;
    cloud.position.y = 5.5 + Math.sin(lt * .9) * .2;
    for (let i = 0; i < FN; i++) {
      const u = frac(fSeed[i] + lt * .05), cls = fCls[i];
      const dieAt = cls === 0 ? uNode[2] : cls === 1 ? uNode[3] : 2;
      path.getPoint(Math.min(u, 1), tmp);
      const tight = u > uNode[3] ? .25 : u > uNode[2] ? .6 : 1;
      F.pos.set([tmp.x, tmp.y + fOff[i * 2] * 1.3 * tight, tmp.z + fOff[i * 2 + 1] * 1.6 * tight], i * 3);
      F.al[i] = u > dieAt ? 0 : Math.min(1, (dieAt - u) * 40) * smooth(u * 20);
      color.copy(u > uNode[3] ? cGreen : u > uNode[2] ? cViolet : cCyan);
      F.col.set([color.r, color.g, color.b], i * 3);
    }
    F.commit();
    const bk = frac(lt * .55);
    burst.scale.setScalar(.6 + bk * 3.2);
    burst.quaternion.copy(camera.quaternion);
    factor(burst, Math.pow(1 - bk, 2) * smooth(prog(lt, 14.5, 16)));
  }};
}

// ---------- scene 4 · efficiency ----------
const PILLAR_X = [-12, -4, 4, 12], PILLAR_Z = [0, -2.2, -2.2, 0], PILLAR_H = [5.4, 7.6, 6.4, 4.6];
const pillarHeight = (lt, i) => PILLAR_H[i] * easeOut(prog(lt, .9 + i * .35, 2.6 + i * .35));
function buildEfficiency() {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(15, 96), new THREE.MeshBasicMaterial({color: 0x041628, transparent: true, opacity: .65, depthWrite: false}));
  disc.rotation.x = -Math.PI / 2;
  const grid = new THREE.PolarGridHelper(15, 16, 6, 96, 0x1a6f9a, 0x0f3d5c);
  grid.material.transparent = true; grid.material.opacity = .55; grid.material.depthWrite = false;
  grid.position.y = .02;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(15, .06, 8, 200), basic(COL.cyan, .9));
  rim.rotation.x = Math.PI / 2;
  const sweep = new THREE.Mesh(new THREE.RingGeometry(.5, 15, 64, 1, 0, .6), basic(COL.cyan, .1));
  sweep.rotation.x = -Math.PI / 2; sweep.position.y = .04;
  g.add(disc, grid, rim, sweep);
  const colors = [COL.cyan, COL.violet, COL.green, COL.blue];
  const pillars = PILLAR_X.map((x, i) => {
    const p = new THREE.Group();
    p.position.set(x, 0, PILLAR_Z[i]);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 1, 6, 1, true), basic(colors[i], .16));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.35, 1.35, 1, 6)), lineMat(colors[i], .9));
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, 1, 12), basic(0xffffff, .35));
    const cap = new THREE.Mesh(new THREE.CircleGeometry(1.35, 6), basic(colors[i], .55));
    cap.rotation.x = -Math.PI / 2;
    const capGlow = glowSprite(colors[i], 5, .8);
    const base = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.0, 6), basic(colors[i], .6));
    base.rotation.x = -Math.PI / 2; base.position.y = .05;
    p.add(body, edges, core, cap, capGlow, base);
    g.add(p);
    anchor(g, `m${i}`, x, 0, PILLAR_Z[i]);
    return {body, edges, core, cap, capGlow};
  });
  const SN = 360, sp = makePoints(SN), r = rng(31), sSeed = new Float32Array(SN), sAng = new Float32Array(SN), sP = new Uint8Array(SN);
  for (let i = 0; i < SN; i++) {sSeed[i] = r(); sAng[i] = r() * 6.28; sP[i] = i % 4; sp.sz[i] = .1 + r() * .14; sp.setColor(i, colors[i % 4]);}
  g.add(sp.points);
  return {group: g, update(lt) {
    sweep.rotation.z = -lt * .9;
    pillars.forEach((p, i) => {
      const h = Math.max(.001, pillarHeight(lt, i));
      for (const m of [p.body, p.edges, p.core]) {m.scale.y = h; m.position.y = h / 2;}
      p.cap.position.y = h; p.capGlow.position.y = h;
      anchors[`m${i}`].position.y = h + 1.9;
    });
    for (let i = 0; i < SN; i++) {
      const pi = sP[i], h = pillarHeight(lt, pi), u = frac(sSeed[i] + lt * .18), a = sAng[i] + lt * .6;
      sp.pos.set([PILLAR_X[pi] + Math.cos(a) * 1.9, u * (h + 1.5), PILLAR_Z[pi] + Math.sin(a) * 1.9], i * 3);
      sp.al[i] = Math.sin(u * Math.PI) * (h > .2 ? 1 : 0);
    }
    sp.commit();
  }};
}

// ---------- scene 5 · results ----------
const GAUGES = [[95.9, COL.cyan], [95.1, COL.violet], [95.5, COL.green]];
const GAUGE_X = [-12.5, 0, 12.5], GAUGE_R = 4.3;
function buildResults() {
  const g = new THREE.Group();
  const gauges = GAUGES.map(([v, color], i) => {
    const grp = new THREE.Group();
    grp.position.set(GAUGE_X[i], 0, 0);
    grp.rotation.y = -GAUGE_X[i] * .012;
    const track = new THREE.Mesh(new THREE.TorusGeometry(GAUGE_R, .2, 12, 180), basic(0x1b3d5c, .55, {blending: THREE.NormalBlending}));
    const arc = new THREE.Mesh(new THREE.BufferGeometry(), basic(color, .75));
    arc.rotation.z = Math.PI / 2; arc.scale.x = -1;
    const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(.06, .36, .06), basic(0x5fa9d6, .5), 72);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let k = 0; k < 72; k++) {
      const a = k / 72 * Math.PI * 2;
      q.setFromAxisAngle(new V3(0, 0, 1), a);
      m4.compose(new V3(Math.cos(a + Math.PI / 2) * 5.2, Math.sin(a + Math.PI / 2) * 5.2, 0), q, new V3(1, k % 6 ? 1 : 1.8, 1));
      ticks.setMatrixAt(k, m4);
    }
    const head = glowSprite(color, 3.2, 1);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(GAUGE_R - .35, 96), new THREE.MeshBasicMaterial({color: 0x0a1a36, transparent: true, opacity: .88, depthWrite: false}));
    disc.position.z = -.1;
    const glow = glowSprite(color, 16, .14);
    glow.position.z = -.5;
    grp.add(glow, disc, track, arc, ticks, head);
    g.add(grp);
    anchor(g, `g${i}`, GAUGE_X[i], .1, .2);
    return {grp, arc, head, v};
  });
  const OR = makePoints(450), r = rng(37), oSeed = new Float32Array(450), oRad = new Float32Array(450);
  for (let i = 0; i < 450; i++) {oSeed[i] = r(); oRad[i] = GAUGE_R + .6 + r() * 1.4; OR.sz[i] = .08 + r() * .12; OR.setColor(i, GAUGES[i % 3][1]);}
  g.add(OR.points);
  return {group: g, update(lt) {
    gauges.forEach(({arc, head, v}, i) => {
      const p = easeOut(prog(lt, 1.6 + i * .4, 3.8 + i * .4)) * v / 100;
      arc.geometry.dispose();
      arc.geometry = new THREE.TorusGeometry(GAUGE_R, .3, 16, 220, Math.max(.001, p * Math.PI * 2));
      const a = Math.PI / 2 - p * Math.PI * 2;
      head.position.set(Math.cos(a) * GAUGE_R, Math.sin(a) * GAUGE_R, .1);
      factor(head, p > .002 ? 1 : 0);
    });
    for (let i = 0; i < 450; i++) {
      const gi = i % 3, a = oSeed[i] * 6.28 + lt * (.25 + oSeed[i] * .3) * (gi === 1 ? -1 : 1);
      OR.pos.set([GAUGE_X[gi] + Math.cos(a) * oRad[i], Math.sin(a) * oRad[i], Math.sin(a * 3 + i) * .4], i * 3);
      OR.al[i] = .35 + .4 * Math.sin(lt * 2 + i);
    }
    OR.commit();
  }};
}

// ---------- scene 6 · impact ----------
const CARD_POS = [[8.2, 7.2, 1], [11.2, 1.2, 0], [8.4, -6.2, 1], [-1.5, -9.6, 2]];
function buildImpact() {
  const g = new THREE.Group();
  const globe = new THREE.Group();
  const R = 7, N = 5200, P = makePoints(N);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + .5) / N * 2, rad = Math.sqrt(1 - y * y), th = i * 2.39996;
    const x = Math.cos(th) * rad, z = Math.sin(th) * rad, lat = Math.asin(y), lon = Math.atan2(x, z);
    const n = Math.sin(3 * lat + .4) * Math.cos(2 * lon) + .55 * Math.sin(5 * lon + 1.3) * Math.cos(4 * lat + .7) + .3 * Math.sin(9 * lat + 7 * lon);
    const land = n > .3;
    P.pos.set([x * R, y * R, z * R], i * 3);
    P.sz[i] = land ? .17 : .1;
    P.al[i] = land ? .95 : .3;
    P.setColor(i, land ? 0x5fe6ff : 0x2a5cff);
  }
  P.commit();
  const occluder = new THREE.Mesh(new THREE.SphereGeometry(R * .985, 64, 32), new THREE.MeshBasicMaterial({color: 0x020a18, transparent: true, opacity: .92}));
  const wire = new THREE.Mesh(new THREE.SphereGeometry(R * 1.002, 36, 18), basic(0x2a7dff, .08, {wireframe: true}));
  occluder.renderOrder = -2; wire.renderOrder = -1;
  globe.add(occluder, wire, P.points);
  const lat = THREE.MathUtils.degToRad(21), lon = THREE.MathUtils.degToRad(78);
  const india = new V3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 3, 8), basic(COL.saffron, 1));
  beam.position.copy(india).multiplyScalar(R + 1.5);
  beam.quaternion.setFromUnitVectors(new V3(0, 1, 0), india);
  const pinGlow = glowSprite(COL.saffron, 3.4, 1);
  pinGlow.position.copy(india).multiplyScalar(R + .1);
  const pinRing = new THREE.Mesh(new THREE.RingGeometry(.5, .6, 48), basic(COL.saffron, .9));
  pinRing.position.copy(india).multiplyScalar(R + .05);
  pinRing.quaternion.setFromUnitVectors(new V3(0, 0, 1), india);
  globe.add(beam, pinGlow, pinRing);
  g.add(glowSprite(0x2f6bff, 30, .35), globe);

  const orbit = new THREE.Group();
  orbit.rotation.set(1.15, 0, .35);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(10.5, .03, 6, 260), basic(COL.cyan, .5));
  const sat = new THREE.Group();
  const satBody = new THREE.Mesh(new THREE.BoxGeometry(.6, .6, .8), new THREE.MeshBasicMaterial({color: 0xd9b45a}));
  const panelMat = new THREE.MeshBasicMaterial({color: 0x2a6dff});
  for (const s of [-1, 1]) {const pn = new THREE.Mesh(new THREE.BoxGeometry(1.6, .04, .6), panelMat); pn.position.x = s * 1.15; sat.add(pn);}
  sat.add(satBody, glowSprite(0xffffff, 1.8, .7));
  orbit.add(ring, sat);
  g.add(orbit);

  const links = CARD_POS.map(([x, y, z], i) => {
    const a = new V3(x, y, z), b = a.clone().normalize().multiplyScalar(R + .2);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([b, a]), lineMat(i === 0 ? COL.saffron : COL.cyan, .7));
    const dot = glowSprite(i === 0 ? COL.saffron : COL.cyan, 1.3, 1);
    dot.position.copy(b);
    g.add(line, dot);
    anchor(g, `c${i}`, x, y, z);
    return {line, dot};
  });
  return {group: g, update(lt) {
    globe.rotation.y = -lon + .55 + (lt - 6.5) * .08;
    globe.rotation.x = .25;
    factor(pinGlow, .7 + .3 * Math.sin(lt * 4));
    const pk = frac(lt * .7);
    pinRing.scale.setScalar(1 + pk * 3);
    factor(pinRing, Math.pow(1 - pk, 2));
    const a = lt * .45;
    sat.position.set(Math.cos(a) * 10.5, Math.sin(a) * 10.5, 0);
    sat.rotation.set(0, 0, a);
    links.forEach(({line, dot}, i) => {const k = smooth(prog(lt, 2.6 + i * .6, 3.4 + i * .6)); factor(line, k); factor(dot, k);});
  }};
}

// ---------- scene 7 · closing ----------
function buildOutro() {
  const g = new THREE.Group(), orb = makeOrb();
  g.add(orb.group);
  const disc = new THREE.Group();
  disc.rotation.set(.42, 0, -.12);
  const N = 3400, P = makePoints(N), r = rng(41), rad = new Float32Array(N), th0 = new Float32Array(N), yy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    rad[i] = 7.5 + Math.pow(r(), .75) * 20;
    th0[i] = (i % 3) * Math.PI * 2 / 3 + rad[i] * .32 + (r() - .5) * .9;
    yy[i] = (r() - .5) * 1.1 * (1 - rad[i] / 30);
    P.sz[i] = .08 + r() * .2;
    P.setColor(i, rad[i] < 13 ? (r() > .5 ? 0xffffff : COL.cyan) : rad[i] < 20 ? COL.cyan : COL.violet);
  }
  disc.add(P.points);
  g.add(disc);
  return {group: g, update(lt) {
    orb.update(lt + 20, Math.exp(-Math.pow(lt - 1.1, 2) / .4) * .9);
    const grow = easeOut(prog(lt, 0, 4));
    for (let i = 0; i < N; i++) {
      const th = th0[i] + lt * 1.4 / Math.sqrt(rad[i]), R = rad[i] * (.25 + .75 * grow);
      P.pos.set([Math.cos(th) * R, yy[i], Math.sin(th) * R], i * 3);
      P.al[i] = grow * (.6 + .4 * Math.sin(lt * 2 + i));
    }
    P.commit();
  }};
}

// ---------- timeline ----------
function orbitPose(c, r, h, a, shift = 0, lookY = 0) {
  const right = new V3(Math.cos(a), 0, -Math.sin(a));
  const pos = new V3(c.x + Math.sin(a) * r, c.y + h, c.z + Math.cos(a) * r).addScaledVector(right, -shift);
  const look = new V3(c.x, c.y + lookY, c.z).addScaledVector(right, -shift);
  return [pos, look];
}
const SCENES = [
  {start: 0, build: buildIntro, cam: lt => [new V3(6 * Math.sin(lt * .12), 2 + 1.2 * Math.cos(lt * .1), lerp(90, 40, easeOut(prog(lt, 0, 9.5)))), new V3(0, -6.2, 0)]},
  {start: 11, build: buildProblem, cam: lt => orbitPose(new V3(2, 1.5, 0), 35, 5, -.24 + lt * .022, 11, 0)},
  {start: 25, build: buildSolution, cam: lt => orbitPose(new V3(1.2, 1, 0), 22, 6.5, .32 - lt * .022, 7.4, .4)},
  {start: 39, build: buildPipeline, cam: lt => {const x = pipeFocus(lt); return [new V3(x - 3.2, 4.2, 23.5), new V3(x, 1.6, 0)];}},
  {start: 63, build: buildEfficiency, cam: lt => orbitPose(new V3(0, 4.2, -1), 42, 10, -.2 + lt * .022, 11.5, 0)},
  {start: 80, build: buildResults, cam: lt => [new V3(Math.sin(lt * .05) * 3, 3, lerp(47, 40, ease(prog(lt, 0, 14)))), new V3(0, 1.8, 0)]},
  {start: 95, build: buildImpact, cam: lt => orbitPose(new V3(0, 0, 0), 34, 3, -.1 + lt * .014, 4.6, .2)},
  {start: 108, build: buildOutro, cam: lt => [new V3(8 * Math.sin(lt * .06), 4, lerp(38, 46, easeOut(prog(lt, 0, 12)))), new V3(0, -6.4, 0)]},
];
SCENES.forEach((s, i) => {s.end = SCENES[i + 1]?.start ?? DURATION; s.origin = new V3(0, 0, -i * 150);});

const pose = (i, t) => {const s = SCENES[i], [p, l] = s.cam(t - s.start); return [p.add(s.origin), l.add(s.origin)];};
const TR = 1.0;
function cameraPose(t) {
  let i = SCENES.findIndex(s => t < s.end);
  if (i < 0) i = SCENES.length - 1;
  const s = SCENES[i], here = pose(i, t);
  let from = null, to = null, w = 0;
  if (i + 1 < SCENES.length && t > s.end - TR) {from = here; to = pose(i + 1, t); w = ease(prog(t, s.end - TR, s.end + TR));}
  else if (i > 0 && t < s.start + TR) {from = pose(i - 1, t); to = here; w = ease(prog(t, s.start - TR, s.start + TR));}
  if (!from) return here;
  const p = from[0].lerp(to[0], w), l = from[1].lerp(to[1], w);
  p.y += Math.sin(w * Math.PI) * 6;
  return [p, l];
}

// ---------- DOM overlays ----------
const sections = [...document.querySelectorAll('.sec')];
const pins = [...document.querySelectorAll('[data-pin]')];
const leftshade = document.getElementById('leftshade'), fadeEl = document.getElementById('fade');
const proj = new V3();
function updateDom(t) {
  let shade = 0;
  for (const sec of sections) {
    const s = SCENES[+sec.dataset.s], lt = t - s.start;
    const out = s.end >= DURATION ? 1 : 1 - smooth(prog(t, s.end - .75, s.end - .15));
    const vis = t >= s.start - .01 && t < s.end ? out : 0;
    sec.style.opacity = vis;
    if (sec.dataset.shade) shade = Math.max(shade, vis * smooth(prog(lt, 0, .9)));
    if (!vis) continue;
    for (const el of sec.querySelectorAll('[data-in]')) {
      const din = +el.dataset.in, a = easeOut(prog(lt, din, din + .75));
      const o = el.dataset.out ? 1 - smooth(prog(lt, +el.dataset.out - .45, +el.dataset.out)) : 1;
      el.style.opacity = a * o;
      const pin = el.parentElement.classList.contains('pin') ? el.parentElement : null;
      const anchorShift = pin ? (pin.classList.contains('mid') ? 'translate(-50%,-50%) ' : 'translate(-50%,-100%) ') : '';
      el.style.transform = `${anchorShift}translateY(${((1 - a) * 34).toFixed(2)}px)`;
      el.style.filter = a < .999 ? `blur(${((1 - a) * 10).toFixed(2)}px)` : 'none';
    }
    for (const el of sec.querySelectorAll('[data-count]')) {
      const k = easeOut(prog(lt, +el.dataset.cin, +el.dataset.cin + 1.8)), dec = +(el.dataset.dec || 0);
      el.textContent = `${el.dataset.prefix || ''}${(+el.dataset.count * k).toFixed(dec)}${el.dataset.suffix || ''}`;
    }
  }
  leftshade.style.opacity = shade;
  for (const pin of pins) {
    const a = anchors[pin.dataset.pin];
    if (!a || pin.closest('.sec').style.opacity === '0') continue;
    a.getWorldPosition(proj).project(camera);
    pin.style.transform = `translate(${((proj.x + 1) / 2 * W).toFixed(1)}px, ${((1 - proj.y) / 2 * H).toFixed(1)}px)`;
  }
  fadeEl.style.opacity = Math.max(1 - smooth(prog(t, 0, 1.4)), smooth(prog(t, DURATION - 1.4, DURATION - .05)));
}

// ---------- frame ----------
const built = [];
const twinkle = (t) => {
  for (let i = 0; i < stars.n; i++) stars.al[i] = starBase[i] * (.7 + .3 * Math.sin(t * (1 + (i % 7) * .3) + i));
  stars.commit();
  for (let i = 0; i < dust.n; i++) dust.al[i] = .25 + .35 * (.5 + .5 * Math.sin(t * 1.3 + dustPhase[i]));
  dust.commit();
};
function renderFrame(t) {
  t = clamp(t, 0, DURATION);
  const [p, l] = cameraPose(t);
  camera.position.copy(p);
  camera.lookAt(l);
  camera.updateMatrixWorld();
  stars.points.position.copy(camera.position);
  stars.points.rotation.y = t * .006;
  twinkle(t);
  terrain.position.set(0, camera.position.y - 15, camera.position.z - 30);
  terrainUniforms.uTime.value = t;
  terrainUniforms.uOffset.value = terrain.position.z;
  SCENES.forEach((s, i) => {
    const a = Math.min(smooth(prog(t, s.start - .55, s.start + .6)), s.end >= DURATION ? 1 : 1 - smooth(prog(t, s.end - .6, s.end + .55)));
    const sc = built[i];
    if (a > .003) sc.update(t - s.start);
    setAlpha(sc.group, a);
  });
  scene.updateMatrixWorld();
  updateDom(t);
  composer.render();
}

await document.fonts.load('700 96px "Space Grotesk"');
await document.fonts.load('600 50px "Space Grotesk"');
await document.fonts.load('400 50px Inter');
await document.fonts.ready;
SCENES.forEach((s, i) => {
  const sc = s.build();
  sc.group.position.copy(s.origin);
  scene.add(sc.group);
  built.push(sc);
});
window.renderFrame = renderFrame;
window.FILM_DURATION = DURATION;
renderFrame(0);
window.filmReady = true;

// Live preview when opened directly in a browser (not used by the renderer).
if (new URLSearchParams(location.search).has('play')) {
  const t0 = performance.now(), from = +(new URLSearchParams(location.search).get('t') || 0);
  const loop = () => {renderFrame((from + (performance.now() - t0) / 1000) % DURATION); requestAnimationFrame(loop);};
  loop();
}
