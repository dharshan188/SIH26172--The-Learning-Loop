// MARVIN · SIH 2026 film. Every frame is a pure function of time t (seconds),
// so frames can be rendered out of order by parallel workers: renderFrame(t).
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

const W = 1920, H = 1080, V3 = THREE.Vector3;
// index.html is the main film; impact.html sets data-cut="impact" for the 50 s feasibility/impact cut.
const CUT = document.body.dataset.cut || 'main';
export const DURATION = CUT === 'impact' ? 50 : 135;

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
const QS = new URLSearchParams(location.search), DPR = +(QS.get('dpr') || 1);
renderer.setPixelRatio(DPR);
renderer.setSize(W, H, false);
const scene = new THREE.Scene();
{
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 576;
  const x = c.getContext('2d');
  const lin = x.createLinearGradient(0, 0, 0, 576);
  lin.addColorStop(0, '#1a3463'); lin.addColorStop(.55, '#0f2245'); lin.addColorStop(1, '#081429');
  x.fillStyle = lin; x.fillRect(0, 0, 1024, 576);
  const rad = x.createRadialGradient(560, 170, 20, 560, 220, 620);
  rad.addColorStop(0, 'rgba(120,170,255,.22)'); rad.addColorStop(1, 'rgba(120,170,255,0)');
  x.fillStyle = rad; x.fillRect(0, 0, 1024, 576);
  const bg = new THREE.CanvasTexture(c);
  bg.colorSpace = THREE.SRGBColorSpace;
  scene.background = bg;
}
scene.fog = new THREE.FogExp2(0x10244a, 0.0085);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 1500);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, {type: THREE.HalfFloatType, samples: +(QS.get('msaa') ?? 4)}));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.42, 0.4, 0.82);
if (!QS.has('nobloom')) composer.addPass(bloom);
composer.addPass(new OutputPass());
composer.setPixelRatio(DPR);
composer.setSize(W, H);
const POINT_SCALE = DPR * H / (2 * Math.tan(THREE.MathUtils.degToRad(42) / 2));

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
    dust.pos.set([(r() - .5) * 200, (r() - .5) * 90 + 6, 90 - r() * 2000], i * 3);
    dust.setColor(i, r() > .7 ? COL.violet : 0x6fd8ff, .8);
    dust.sz[i] = .12 + r() * .3;
    dustPhase[i] = r() * 6.28;
  }
  scene.add(dust.points);
}

// Soft photographic bokeh: out-of-focus lights far behind the subject.
const bokehTex = canvasTexture(128, 128, (x) => {
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(.78, 'rgba(255,255,255,.62)');
  g.addColorStop(.9, 'rgba(255,255,255,.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
});
bokehTex.colorSpace = THREE.NoColorSpace;
const bokeh = new THREE.Group(), bokehSeeds = [];
{
  const r = rng(9);
  for (let i = 0; i < 26; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map: bokehTex, color: [0x86b6ff, 0xa892ff, 0x7fe0ff, 0xffd6a8][i % 4], opacity: .025 + r() * .045, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false}));
    s.scale.setScalar(3 + r() * 8);
    bokehSeeds.push([(r() - .5) * 150, (r() - .5) * 70 + 8, -60 - r() * 70, r() * 6.28, .2 + r() * .4]);
    bokeh.add(s);
  }
  scene.add(bokeh);
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
    const energy = Math.exp(-Math.pow(lt - 1.9, 2) / .35) * 1.2 + Math.exp(-Math.pow(lt - 3.1, 2) / .5) * .5;
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
  const mat = (color, metalness = .2, roughness = .6, extra = {}) => new THREE.MeshStandardMaterial({color, metalness, roughness, ...extra});

  // Studio floor under both objects so nothing floats.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(24, 96), new THREE.MeshBasicMaterial({transparent: true, depthWrite: false, map: canvasTexture(512, 512, (x) => {
    const gr = x.createRadialGradient(256, 256, 0, 256, 256, 256);
    gr.addColorStop(0, 'rgba(120,160,230,.32)'); gr.addColorStop(.6, 'rgba(80,120,200,.12)'); gr.addColorStop(1, 'rgba(60,90,160,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 512, 512);
  })}));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -4.2;
  g.add(floor);

  // Smart speaker: fabric body, dark top, glowing listening ring, built-in battery gauge.
  const dev = new THREE.Group();
  dev.position.set(-5.5, -4.2, 1);
  const fabric = canvasTexture(512, 512, (x) => {
    x.fillStyle = '#2b3442'; x.fillRect(0, 0, 512, 512);
    x.fillStyle = '#1a212c';
    for (let yy = 4; yy < 512; yy += 9) for (let xx = (yy / 9 % 2) * 4.5; xx < 512; xx += 9) {x.beginPath(); x.arc(xx, yy, 2.1, 0, Math.PI * 2); x.fill();}
  });
  fabric.wrapS = fabric.wrapT = THREE.RepeatWrapping; fabric.repeat.set(4, 2);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.25, 5.6, 96, 1, true), mat(0xffffff, 0, .95, {map: fabric, envMapIntensity: .3}));
  body.position.y = 2.8;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.27, 2.3, .25, 96), mat(0x151a22, .3, .5));
  base.position.y = .12;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.12, 2.1, .32, 96), mat(0x10141b, .4, .35));
  cap.position.y = 5.75;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.72, .09, 16, 160), basic(COL.red, 1));
  ring.rotation.x = Math.PI / 2; ring.position.y = 5.93;
  const ringGlow = glowSprite(COL.red, 5.5, .9);
  ringGlow.position.y = 6.1;
  const buttons = [-.6, 0, .6].map(xx => {const b2 = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, .05, 24), mat(0x2a3140, .3, .4)); b2.position.set(xx, 5.93, .9); return b2;});
  dev.add(body, base, cap, ring, ringGlow, ...buttons);
  const waves = [0, 1, 2].map(() => {const m = new THREE.Mesh(new THREE.RingGeometry(1, 1.03, 128), basic(COL.red, .45)); m.rotation.x = -Math.PI / 2; m.position.y = 5.95; dev.add(m); return m;});
  g.add(dev);

  // Cloud server: a lit rack standing inside a soft cloud.
  const srv = new THREE.Group();
  srv.position.set(8.6, -4.2, -4);
  const rackFace = canvasTexture(512, 160, (x) => {
    x.fillStyle = '#1b2230'; x.fillRect(0, 0, 512, 160);
    x.fillStyle = '#0d1118';
    for (let i = 0; i < 18; i++) x.fillRect(150 + i * 18, 40, 9, 80);
    x.strokeStyle = '#3a4558'; x.lineWidth = 4; x.strokeRect(6, 6, 500, 148);
  });
  const units = [0, 1, 2, 3].map(i => {
    const u = new THREE.Mesh(new THREE.BoxGeometry(3.4, .95, 2.6), [mat(0x1c2230, .6, .4), mat(0x1c2230, .6, .4), mat(0x1c2230, .6, .4), mat(0x1c2230, .6, .4), mat(0xffffff, .3, .5, {map: rackFace}), mat(0x1c2230, .6, .4)]);
    u.position.y = .55 + i * 1.02;
    srv.add(u);
    return u;
  });
  const leds = [];
  units.forEach((u, i) => [0, 1, 2].forEach(k => {
    const l = new THREE.Mesh(new THREE.CircleGeometry(.07, 16), basic(k === 2 ? 0x8fb4ff : COL.green, 1));
    l.position.set(-1.35 + k * .22, u.position.y, 1.31);
    srv.add(l); leds.push(l);
  }));
  for (const [x, y, z, rad] of [[0, 4.6, 0, 3.2], [2.8, 3.9, .3, 2.4], [-2.8, 3.8, .2, 2.3], [1.2, 6.2, -.3, 2.3], [-1.5, 5.8, .1, 2.1]]) {
    const fill = new THREE.Mesh(new THREE.SphereGeometry(rad, 48, 32), basic(0x9cc0ff, .07));
    fill.position.set(x, y, z - 1.2);
    srv.add(fill);
  }
  srv.add(glowSprite(0x6f9dff, 18, .5).translateY(4.5).translateZ(-1.5));
  const coinGeo = new THREE.CylinderGeometry(.62, .62, .16, 40), coinMat = mat(0xf2b544, 1, .28, {envMapIntensity: 1.2});
  const coins = [];
  [[-3.4, 2.4], [-4.6, 1.2], [-3.6, .1]].forEach(([cx, cz], st) => {
    for (let k = 0; k < 12; k++) {
      const coin = new THREE.Mesh(coinGeo, coinMat);
      coin.position.set(cx + Math.sin(k * 1.7 + st) * .04, .08 + k * .17, cz);
      coin.rotation.y = k;
      coin.userData.order = st * 12 + k;
      srv.add(coin); coins.push(coin);
    }
  });
  g.add(srv);

  // Audio leaving the device: waveform tiles and a particle trail along an arc.
  const curve = new THREE.CubicBezierCurve3(new V3(-5.5, 2.2, 1), new V3(-3, 10, 1.5), new V3(3.5, 11, -2), new V3(8.2, 3.6, -3.5));
  const N = 500, S = makePoints(N), r = rng(13), seed = new Float32Array(N), off = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {seed[i] = r(); off.set([r() - .5, r() - .5, r() - .5], i * 3); S.sz[i] = .1 + r() * .16; S.setColor(i, r() > .5 ? COL.orange : COL.red);}
  g.add(S.points);
  const tileTex = canvasTexture(256, 140, (x) => {
    x.fillStyle = 'rgba(70,24,30,.9)'; x.beginPath(); x.roundRect(4, 4, 248, 132, 22); x.fill();
    x.strokeStyle = '#ffb08a'; x.lineWidth = 4; x.stroke();
    x.strokeStyle = '#ffd1bd'; x.lineWidth = 5; x.beginPath();
    for (let i = 0; i <= 200; i++) {const xx = 28 + i, yy = 70 + Math.sin(i * .21) * 34 * Math.sin(i / 200 * Math.PI); i ? x.lineTo(xx, yy) : x.moveTo(xx, yy);}
    x.stroke();
  });
  const tiles = Array.from({length: 7}, () => {const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, .82), new THREE.MeshBasicMaterial({map: tileTex, transparent: true, depthWrite: false, color: new THREE.Color(.95, .95, .95)})); g.add(m); return m;});

  anchor(g, 'p-cloud', 9.5, 6.6, -2);
  const streamPin = anchor(g, 'p-stream', 0, 0, 0);
  streamPin.position.copy(curve.getPoint(.5)).add(new V3(0, 1.4, 0));
  anchor(g, 'p-mic', -5.5, 3.4, 1);
  anchor(g, 'p-cost', 4.6, -4.4, -1.6);

  const tmp = new V3(), red = new THREE.Color(COL.red), green = new THREE.Color(COL.green), amber = new THREE.Color(COL.orange);
  return {group: g, update(lt) {
    factor(ring, .75 + .25 * Math.sin(lt * 5));
    factor(ringGlow, .7 + .3 * Math.sin(lt * 5));
    waves.forEach((w, i) => {const k = frac(lt * .6 + i / 3); w.scale.setScalar(2 + k * 6); factor(w, Math.pow(1 - k, 2));});
    dev.rotation.y = Math.sin(lt * .3) * .12;
    const shown = Math.floor(easeOut(prog(lt, 1.2, 9.5)) * coins.length);
    coins.forEach(cn => {cn.visible = cn.userData.order < shown;});
    leds.forEach((l, i) => factor(l, .35 + .65 * (Math.sin(lt * (3 + i % 4) + i * 1.7) > 0 ? 1 : 0)));
    for (let i = 0; i < N; i++) {
      const u = frac(seed[i] + lt * .24), spread = Math.sin(u * Math.PI) * 1.2;
      curve.getPoint(u, tmp);
      S.pos.set([tmp.x + off[i * 3] * spread, tmp.y + off[i * 3 + 1] * spread, tmp.z + off[i * 3 + 2] * spread], i * 3);
      S.al[i] = Math.pow(Math.sin(u * Math.PI), .6) * .8;
    }
    S.commit();
    tiles.forEach((m, i) => {
      const u = frac(i / tiles.length + lt * .12);
      curve.getPoint(u, m.position);
      m.quaternion.copy(camera.quaternion);
      m.scale.setScalar(.6 + .5 * Math.sin(u * Math.PI));
      factor(m, Math.sin(u * Math.PI));
    });
  }};
}

// ---------- lighting for the hardware models ----------
{
  scene.add(new THREE.AmbientLight(0x8fa8c8, .55));
  const key = new THREE.DirectionalLight(0xffffff, .95);
  key.position.set(6, 14, 10);
  const rim = new THREE.DirectionalLight(0x9fd8ff, .55);
  rim.position.set(-10, 6, -8);
  scene.add(key, rim);
}
const std = (color, metalness = .2, roughness = .6, extra = {}) => new THREE.MeshStandardMaterial({color, metalness, roughness, ...extra});
const anchorOn = (parent, name, x, y, z) => {const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); anchors[name] = o; return o;};

// ---------- realistic hardware ----------
function makeEsp32() {
  const board = new THREE.Group();
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(7.2, .16, 3.2), std(0x0c1d2b, .25, .55));
  board.add(pcb, new THREE.LineSegments(new THREE.EdgesGeometry(pcb.geometry), lineMat(0x2bd8ff, .5)));
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
  board.add(mod, shield, label, new THREE.Line(new THREE.BufferGeometry().setFromPoints(antenna), lineMat(0xffc65c, 1)));
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
  const led = new THREE.Mesh(new THREE.BoxGeometry(.18, .1, .12), basic(0xff4b5c, 1));
  led.position.set(-1.1, .13, -1.12);
  const ledGlow = glowSprite(0xff4b5c, 1.4, 1);
  ledGlow.position.copy(led.position);
  board.add(led, ledGlow);
  const pins = new THREE.InstancedMesh(new THREE.CylinderGeometry(.045, .045, .9, 8), std(0xe0b45a, 1, .3), 38);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 38; i++) {m4.makeTranslation(-3.15 + (i % 19) * .35, -.6, i < 19 ? 1.42 : -1.42); pins.setMatrixAt(i, m4);}
  board.add(pins);
  for (const z of [1.42, -1.42]) {
    const hdr = new THREE.Mesh(new THREE.BoxGeometry(6.8, .26, .3), std(0x111418, .1, .7));
    hdr.position.set(0, -.21, z);
    board.add(hdr);
  }
  return board;
}

// INMP441 breakout: round purple PCB, MEMS can with sound port, 6-pin header.
const micTop = canvasTexture(512, 512, (x, w, h) => {
  x.fillStyle = '#3b2c8f'; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(255,255,255,.85)'; x.lineWidth = 4;
  x.beginPath(); x.arc(256, 256, 232, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#ffffff'; x.textAlign = 'center';
  x.font = '700 58px "Space Grotesk"'; x.fillText('INMP441', 256, 128);
  x.font = '500 26px Inter'; x.fillText('I²S MEMS MIC', 256, 168);
  const labels = ['SCK', 'WS', 'L/R', 'SD', 'VDD', 'GND'];
  labels.forEach((l, i) => {
    const px = 96 + i * 64;
    x.font = '600 20px Inter'; x.fillStyle = '#ffffff'; x.fillText(l, px, 404);
    x.beginPath(); x.arc(px, 446, 20, 0, Math.PI * 2); x.fillStyle = '#d9b45a'; x.fill();
    x.beginPath(); x.arc(px, 446, 9, 0, Math.PI * 2); x.fillStyle = '#20163f'; x.fill();
  });
});
function makeMic() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(1, 1, .1, 64), std(0x3b2c8f, .1, .75, {envMapIntensity: .3})));
  const top = new THREE.Mesh(new THREE.CircleGeometry(.995, 64), std(0xcfcfe0, .05, .75, {map: micTop, envMapIntensity: .3}));
  top.rotation.x = -Math.PI / 2; top.position.y = .052;
  const can = new THREE.Mesh(new THREE.BoxGeometry(.62, .2, .46), std(0x9aa3ab, 1, .4, {envMapIntensity: .6}));
  can.position.set(0, .15, -.12);
  const port = new THREE.Mesh(new THREE.CircleGeometry(.065, 24), new THREE.MeshBasicMaterial({color: 0x0b0b10}));
  port.rotation.x = -Math.PI / 2; port.position.set(0, .252, -.12);
  g.add(top, can, port);
  for (const x of [-.5, .5]) {const c = new THREE.Mesh(new THREE.BoxGeometry(.16, .08, .08), std(0xc8a165, .1, .5)); c.position.set(x, .09, -.36); g.add(c);}
  const hdr = new THREE.Mesh(new THREE.BoxGeometry(1.6, .2, .2), std(0x111418, .1, .7));
  hdr.position.set(0, -.15, .74);
  g.add(hdr);
  for (let k = 0; k < 6; k++) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, .9, 8), std(0xe0b45a, 1, .3));
    p.position.set(-.625 + k * .25, -.5, .74);
    g.add(p);
  }
  return g;
}

// SSD1306 0.96" OLED: blue PCB, black glass, live 128×64-style screen.
const oledPcbTex = canvasTexture(512, 532, (x, w, h) => {
  x.fillStyle = '#1d55b8'; x.fillRect(0, 0, w, h);
  for (const [cx, cy] of [[34, 34], [478, 34], [34, 498], [478, 498]]) {
    x.beginPath(); x.arc(cx, cy, 22, 0, Math.PI * 2); x.fillStyle = '#d9b45a'; x.fill();
    x.beginPath(); x.arc(cx, cy, 13, 0, Math.PI * 2); x.fillStyle = '#0b1530'; x.fill();
  }
  x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.font = '600 22px Inter';
  ['GND', 'VCC', 'SCL', 'SDA'].forEach((l, i) => {
    const px = 184 + i * 48;
    x.fillText(l, px, 86);
    x.beginPath(); x.arc(px, 40, 15, 0, Math.PI * 2); x.fillStyle = '#d9b45a'; x.fill();
    x.beginPath(); x.arc(px, 40, 7, 0, Math.PI * 2); x.fillStyle = '#0b1530'; x.fill();
    x.fillStyle = '#ffffff';
  });
});
function makeOled() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(2.7, .1, 2.8), std(0x1d55b8, .2, .5)));
  const top = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.8), std(0xffffff, .1, .5, {map: oledPcbTex}));
  top.rotation.x = -Math.PI / 2; top.position.y = .051;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.56, .05, 1.95), std(0x050608, .3, .12));
  glass.position.set(0, .078, .25);
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.15), new THREE.MeshBasicMaterial({map: tex, color: new THREE.Color(.78, .78, .78)}));
  screen.rotation.x = -Math.PI / 2; screen.position.set(0, .106, .2);
  g.add(top, glass, screen);
  const hdr = new THREE.Mesh(new THREE.BoxGeometry(1, .2, .2), std(0x111418, .1, .7));
  hdr.position.set(0, -.15, -1.18);
  g.add(hdr);
  for (let k = 0; k < 4; k++) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, .9, 8), std(0xe0b45a, 1, .3));
    p.position.set(-.375 + k * .25, -.5, -1.18);
    g.add(p);
  }
  let shown = '';
  g.userData.show = (lines, cursor = false) => {
    const key = lines.join('|') + cursor;
    if (key === shown) return;
    shown = key;
    const x = c.getContext('2d');
    x.fillStyle = '#000000'; x.fillRect(0, 0, 512, 256);
    x.fillStyle = '#9eefff'; x.font = '600 30px "Space Grotesk"'; x.fillText(lines[0], 26, 52);
    x.fillRect(26, 70, 460, 3);
    x.fillStyle = '#ffffff';
    lines.slice(1).forEach((l, i) => {x.font = `700 ${l.length > 14 ? 44 : 60}px "Space Grotesk"`; x.fillText(l + (cursor && i === lines.length - 2 ? '_' : ''), 26, 140 + i * 66);});
    tex.needsUpdate = true;
  };
  g.userData.show(['MARVIN', 'READY']);
  return g;
}

// A real photo presented as a floating 3D frame.
function makePhotoFrame(tex, w, h, accent = COL.cyan) {
  const g = new THREE.Group();
  const back = new THREE.Mesh(new THREE.BoxGeometry(w + .36, h + .36, .2), std(0x0e1d36, .4, .35));
  back.position.z = -.13;
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(back.geometry), lineMat(accent, .85));
  edge.position.z = -.13;
  const img = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: tex, color: new THREE.Color(.95, .95, .95)}));
  const glow = glowSprite(accent, Math.max(w, h) * 1.9, .35);
  glow.position.z = -.8;
  g.add(glow, back, edge, img);
  return g;
}

function makeBreadboard() {
  const tex = canvasTexture(1250, 640, (x, w, h) => {
    x.fillStyle = '#e4e8ed'; x.fillRect(0, 0, w, h);
    const hole = (cx, cy) => {x.fillStyle = '#3a3f46'; x.fillRect(cx - 4, cy - 4, 8, 8);};
    for (const [y0, color] of [[30, '#d8434b'], [62, '#2f62c8'], [578, '#d8434b'], [610, '#2f62c8']]) {
      x.fillStyle = color; x.fillRect(30, y0 + (y0 < 300 ? -16 : 16), w - 60, 3);
      for (let i = 0; i < 50; i++) if (i % 6 !== 5) hole(50 + i * 23.5, y0);
    }
    for (let c = 0; c < 60; c++) for (let r = 0; r < 10; r++) hole(40 + c * 19.6, 130 + r * 40 + (r >= 5 ? 30 : 0));
    x.fillStyle = '#cfd5dc'; x.fillRect(20, 315, w - 40, 14);
  });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(12.5, .7, 6.4), std(0x8d97a3, 0, .9, {envMapIntensity: .2})));
  const top = new THREE.Mesh(new THREE.PlaneGeometry(12.5, 6.4), std(0x9ea7b2, 0, .9, {map: tex, envMapIntensity: .2}));
  top.rotation.x = -Math.PI / 2; top.position.y = .351;
  g.add(top);
  return g;
}

function wire(from, to, color, lift = 1.4) {
  const c = new THREE.CatmullRomCurve3([from, from.clone().add(new V3(0, lift * .4, .5)), to.clone().add(new V3(0, lift, 0)), to]);
  return new THREE.Mesh(new THREE.TubeGeometry(c, 48, .055, 8, false), std(color, .1, .55));
}

// ---------- scene 2 · solution / prototype ----------
const PROTO_CAM_A = lt => .14 - lt * .012;
function buildPrototype() {
  const g = new THREE.Group(), rig = new THREE.Group();
  const bb = makeBreadboard();
  const esp = makeEsp32();
  esp.position.set(.3, 1.05, .1);
  const mic = makeMic();
  mic.position.set(-4.9, 1.75, 1.5);
  mic.rotation.set(1.0, .15, 0);
  const oled = makeOled();
  oled.position.set(4.9, 1.9, 1.5);
  oled.rotation.set(1.05, -.12, 0);
  rig.add(bb, esp, mic, oled);
  rig.updateMatrixWorld(true);
  const pinW = (obj, x, y, z) => new V3(x, y, z).applyMatrix4(obj.matrix);
  [[mic, -.625, 0xc8323f, -4.6], [mic, -.375, 0xc9a23e, -4.2], [mic, -.125, 0x2a7fc0, -3.8], [mic, .125, 0x3fa65a, -3.4],
    [oled, -.375, 0x111111, 3.4], [oled, -.125, 0xc8323f, 3.8], [oled, .125, 0xc9a23e, 4.2], [oled, .375, 0x2a7fc0, 4.6]].forEach(([part, px, color, bx]) => {
    const from = pinW(part, px, -.95, part === mic ? .74 : -1.18);
    rig.add(wire(from, new V3(bx, .36, -1.6), color, 1.6));
  });
  anchorOn(esp, 'pr-esp', 1.6, 2.1, 0);
  anchorOn(mic, 'pr-mic', 0, 0, -1.3);
  anchorOn(oled, 'pr-oled', 0, 0, -1.7);
  g.add(rig);

  const photo = makePhotoFrame(TEX.proto, 10.6, 5.96, COL.cyan);
  g.add(photo);
  anchorOn(photo, 'pr-photo', 0, 3.45, 0);
  return {group: g, update(lt) {
    const rise = easeOut(prog(lt, 0, 2));
    // Act 1: the 3D hardware. Act 2: it steps back and the real photo takes the stage.
    const swap = ease(prog(lt, 5.2, 6.6));
    rig.position.set(2.6 + swap * 7, -1.6 - (1 - rise) * 3 - swap * 1.5, -swap * 16);
    rig.rotation.set(.18, -.42 + lt * .035, 0);
    rig.scale.setScalar(1 - swap * .35);
    const blink = Math.floor(lt * 2) % 2 === 0;
    oled.userData.show(lt < 4 ? ['MARVIN', 'READY'] : ['STAGE 2 ✓', 'MARVIN', 'DETECTED'], blink && lt < 4);
    const k = easeOut(prog(lt, 5.5, 7));
    const camA = PROTO_CAM_A(lt);
    photo.position.set(3.3, .9 + Math.sin(lt * .8) * .12, 2.5 - (1 - k) * 4);
    photo.rotation.set(-.04, camA + (1 - k) * 1.5 + Math.sin(lt * .6) * .03, 0);
    photo.scale.setScalar(.45 + .55 * k);
    photo.visible = false;
  }};
}

// ---------- scene 3 · overall workflow ----------
const FLOW_STEP = 4, FLOW_X = Array.from({length: 8}, (_, k) => -49 + k * 14);
const flowFocus = lt => {
  const k = clamp(Math.floor(lt / FLOW_STEP), 0, 7);
  if (k >= 7) return FLOW_X[7];
  return lerp(FLOW_X[k], FLOW_X[k + 1], ease(prog(lt, (k + 1) * FLOW_STEP - 1.1, (k + 1) * FLOW_STEP)));
};
const jet = v => [clamp(1.5 - Math.abs(4 * v - 3)), clamp(1.5 - Math.abs(4 * v - 2)), clamp(1.5 - Math.abs(4 * v - 1))];
function cnnBlocks(x0, colors, sizes) {
  const g = new THREE.Group();
  let x = x0;
  sizes.forEach(([t, s], i) => {
    const geo = new THREE.BoxGeometry(t, s, s);
    const m = new THREE.Mesh(geo, basic(colors[i], .3));
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMat(colors[i], .95));
    m.position.x = e.position.x = x;
    g.add(m, e);
    x += t + .55;
  });
  return g;
}
function buildWorkflow() {
  const g = new THREE.Group(), X = FLOW_X;
  const lerpColor = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();

  // 01 voice input
  const voice = makePoints(560);
  for (let i = 0; i < 560; i++) {voice.sz[i] = .2; voice.setColor(i, i % 4 ? COL.cyan : 0xffffff);}
  const rings = [0, 1, 2].map(() => {const m = new THREE.Mesh(new THREE.RingGeometry(1, 1.03, 128), basic(COL.cyan, .5)); m.position.set(X[0], 1, 0); g.add(m); return m;});
  g.add(voice.points);
  anchor(g, 'wf-bubble', X[0], 4.2, 0);
  anchor(g, 'wf-t0', X[0], -2.7, 0);

  // 02 audio capture
  const mic = makeMic();
  mic.scale.setScalar(2.5);
  mic.position.set(X[1], .7, 0);
  g.add(mic);
  const inflow = makePoints(260), ir = rng(43), inSeed = new Float32Array(260), inOff = new Float32Array(260 * 2);
  for (let i = 0; i < 260; i++) {inSeed[i] = ir(); inOff[i * 2] = ir() - .5; inOff[i * 2 + 1] = ir() - .5; inflow.sz[i] = .16; inflow.setColor(i, COL.cyan);}
  g.add(inflow.points);
  anchor(g, 'wf-t1', X[1], -2.7, 0);

  // 03 preprocessing: framing + noise reduction on the waveform, then Log-Mel 98 × 24
  const wave = makePoints(420);
  for (let i = 0; i < 420; i++) {wave.sz[i] = .16; wave.setColor(i, COL.cyan);}
  g.add(wave.points);
  const frames = Array.from({length: 8}, (_, i) => {
    const f = new THREE.Mesh(new THREE.BoxGeometry(1.05, 2.2, .06), basic(COL.violet, .16));
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(f.geometry), lineMat(COL.violet, .8));
    const grp = new THREE.Group();
    grp.add(f, e);
    grp.position.set(X[2] - 4.4 + i * 1.25, 3.6, .1);
    g.add(grp);
    return {grp, e, f};
  });
  const COLS = 98, ROWS = 24, mel = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({transparent: true}), COLS * ROWS);
  g.add(mel);
  const melFrame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(9.3, 3.8, .1)), lineMat(COL.cyan, .6));
  melFrame.position.set(X[2], -.25, -.1);
  g.add(melFrame);
  const melVal = (c, r) => {
    const segs = [[6, 24, 1], [30, 42, .8], [46, 55, .7], [59, 70, .85], [74, 92, .9]];
    let env = 0;
    for (const [a, b, amp] of segs) if (c >= a && c <= b) env = amp * Math.sin((c - a) / (b - a) * Math.PI);
    const f1 = 4 + 2 * Math.sin(c * .3), f2 = 11 + 4 * Math.sin(c * .17 + 1), f3 = 18 + 2 * Math.sin(c * .11);
    const v = env * (Math.exp(-Math.pow(r - f1, 2) / 4) + .7 * Math.exp(-Math.pow(r - f2, 2) / 5) + .35 * Math.exp(-Math.pow(r - f3, 2) / 6));
    return clamp(v + .06 + .05 * frac(Math.sin(c * 12.9898 + r * 78.233) * 43758.5453));
  };
  const melV = new Float32Array(COLS * ROWS);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) melV[c * ROWS + r] = melVal(c, r);
  anchor(g, 'wf-t2a', X[2], 5.35, 0);
  anchor(g, 'wf-t2', X[2], -2.7, 0);

  // 04 stage-1 CNN · 05 stage-2 temporal verifier
  const s1 = cnnBlocks(X[3] - 3.6, [0x7ee8ff, 0x7fd0ff, 0x8fb4ff, 0x9fa8ff, 0xa99cff, 0xb79bff], [[.45, 3.4], [.7, 3.0], [.55, 2.6], [.75, 2.1], [.55, 1.6], [.5, 1.05]]);
  s1.position.y = .7;
  const s2 = cnnBlocks(X[4] - 3.6, [0xb79bff, 0xc09bff, 0xc79bff, 0xcf9bff, 0xd59bff, 0xdc9bff], [[.45, 3.4], [.7, 3.0], [.55, 2.6], [.75, 2.1], [.55, 1.6], [.5, 1.05]]);
  s2.position.y = .7;
  const windows = [0, 1, 2].map(i => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3), basic(COL.violet, .1));
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(2.2, 3)), lineMat(COL.violet, .6));
    const grp = new THREE.Group();
    grp.add(w, e);
    grp.position.set(X[4] - 5.6, .7, -1.6 + i * 1.6);
    grp.rotation.y = Math.PI / 2;
    g.add(grp);
    return grp;
  });
  g.add(s1, s2);
  const feat = makePoints(500), fr = rng(47), fSeed = new Float32Array(500), fOff = new Float32Array(1000);
  for (let i = 0; i < 500; i++) {fSeed[i] = fr(); fOff[i * 2] = fr() - .5; fOff[i * 2 + 1] = fr() - .5; feat.sz[i] = .13;}
  g.add(feat.points);
  anchor(g, 'wf-s1', X[3], 3.2, 0);
  anchor(g, 'wf-s2', X[4], 3.2, 0);
  anchor(g, 'wf-t3', X[3], -2.7, 0);
  anchor(g, 'wf-t4', X[4], -2.7, 0);

  // 06 decision
  const okRing = new THREE.Mesh(new THREE.TorusGeometry(2.3, .12, 12, 120), basic(COL.green, .9));
  okRing.position.set(X[5] - 1.2, .9, 0);
  const check = new THREE.Group();
  check.position.copy(okRing.position);
  const checkBars = [[new V3(-1.05, .05, 0), new V3(-.3, -.75, 0)], [new V3(-.3, -.75, 0), new V3(1.15, .85, 0)]].map(([a, b]) => {
    const geo = new THREE.BoxGeometry(1, .34, .34);
    geo.translate(.5, 0, 0);
    const m = new THREE.Mesh(geo, basic(COL.green, 1));
    m.position.copy(a);
    m.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
    m.userData.len = a.distanceTo(b) + .12;
    check.add(m);
    return m;
  });
  const noRing = new THREE.Mesh(new THREE.TorusGeometry(1.1, .07, 10, 90), basic(COL.red, .8));
  noRing.position.set(X[5] + 3.6, 2.2, -1);
  const xMat = basic(COL.red, .9);
  const xBars = [Math.PI / 4, -Math.PI / 4].map(a => {const b = new THREE.Mesh(new THREE.BoxGeometry(1.3, .14, .14), xMat); b.rotation.z = a; b.position.copy(noRing.position); g.add(b); return b;});
  const okBurst = [0, 1].map(() => {const m = new THREE.Mesh(new THREE.RingGeometry(1, 1.04, 128), basic(COL.green, .7)); m.position.copy(okRing.position); g.add(m); return m;});
  g.add(okRing, check, noRing);
  anchor(g, 'wf-no', X[5] + 3.6, .8, -1);
  anchor(g, 'wf-t5', X[5], -2.7, 0);

  // 07 cloud ASR
  const cloud = new THREE.Group();
  cloud.position.set(X[6], 1.4, 0);
  for (const [x, y, rad] of [[0, 0, 1.9], [1.8, -.45, 1.4], [-1.8, -.5, 1.35], [.8, 1.1, 1.35]]) {
    const fill = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 3), basic(0x8fb4ff, .08));
    const wire = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 2), basic(0x9fc8ff, .35, {wireframe: true}));
    fill.position.set(x, y, 0); wire.position.set(x, y, 0);
    cloud.add(fill, wire);
  }
  cloud.add(glowSprite(0x6f9dff, 9, .5));
  g.add(cloud);
  const up = makePoints(220), ur = rng(53), uSeed = new Float32Array(220), uOff = new Float32Array(220);
  for (let i = 0; i < 220; i++) {uSeed[i] = ur(); uOff[i] = ur() - .5; up.sz[i] = .16; up.setColor(i, COL.green);}
  g.add(up.points);
  anchor(g, 'wf-asr', X[6], 4.4, 0);
  anchor(g, 'wf-t6', X[6], -2.7, 0);

  // 08 output: OLED + real dashboard screenshot
  const oled = makeOled();
  oled.scale.setScalar(1.8);
  oled.position.set(X[7] - 4.6, .3, 1.6);
  oled.rotation.set(1.12, .25, 0);
  const dash = makePhotoFrame(TEX.dash, 8.6, 4.84, COL.cyan);
  dash.position.set(X[7] + 2.4, 1.3, -1.2);
  dash.rotation.y = -.2;
  g.add(oled, dash);
  anchor(g, 'wf-t7', X[7], -2.95, 0);

  // Flow conduit behind the stations.
  const path = new THREE.CatmullRomCurve3(X.map((x, i) => new V3(x, .8 + (i % 2 ? .3 : -.3), -3.4)));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(path, 400, .05, 6, false), basic(COL.cyan, .3)));
  const FN = 900, F = makePoints(FN), pr = rng(59), pSeed = new Float32Array(FN), pOff = new Float32Array(FN * 2);
  for (let i = 0; i < FN; i++) {pSeed[i] = pr(); pOff[i * 2] = pr() - .5; pOff[i * 2 + 1] = pr() - .5; F.sz[i] = .14 + pr() * .1;}
  g.add(F.points);

  const tmp = new V3(), col = new THREE.Color(), cA = new THREE.Color(COL.cyan), cB = new THREE.Color(COL.violet), cC = new THREE.Color(COL.green);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3();
  return {group: g, update(lt) {
    const S = FLOW_STEP;
    // 01
    for (let i = 0; i < 560; i++) {
      const u = i / 559, env = Math.sin(u * Math.PI) * (.6 + .4 * Math.sin(lt * 1.6 + u * 5));
      const y = env * (Math.sin(u * 70 + lt * 9) * .9 + Math.sin(u * 27 - lt * 5) * .6 + Math.sin(u * 151 + lt * 13) * .25);
      voice.pos.set([X[0] - 4.8 + u * 9.6, 1 + y * 1.3, (i % 3) * .05], i * 3);
      voice.al[i] = .9;
    }
    voice.commit();
    rings.forEach((m, i) => {const k = frac(lt * .5 + i / 3); m.scale.setScalar(1.5 + k * 7); m.quaternion.copy(camera.quaternion); factor(m, Math.pow(1 - k, 2));});
    // 02
    mic.rotation.set(1.05, Math.sin(lt * .6) * .35, Math.sin(lt * .4) * .08);
    for (let i = 0; i < 260; i++) {
      const u = frac(inSeed[i] + lt * .35), k = 1 - u;
      inflow.pos.set([lerp(X[1] - 6.5, X[1], u), .9 + inOff[i * 2] * 4 * k, inOff[i * 2 + 1] * 4 * k + 1.2 * u], i * 3);
      inflow.al[i] = Math.sin(u * Math.PI);
    }
    inflow.commit();
    // 03
    const l3 = lt - 2 * S;
    for (let i = 0; i < 420; i++) {
      const u = i / 419, clean = smooth(prog(u, .35, .75));
      const y = Math.sin(u * Math.PI) * (Math.sin(u * 55 + lt * 6) * .55 + Math.sin(u * 21 - lt * 3) * .35) + (1 - clean) * (frac(Math.sin(i * 91.7 + Math.floor(lt * 12)) * 4375.5) - .5) * .9;
      wave.pos.set([X[2] - 4.8 + u * 9.6, 3.6 + y, .2], i * 3);
      wave.col.set(clean > .5 ? [.49, .91, 1] : [.75, .62, 1], i * 3);
    }
    wave.commit();
    frames.forEach(({grp, e, f}, i) => {const on = frac(lt * .45) * 8; const hot = Math.max(0, 1 - Math.abs(on - i)); factor(e, .35 + .65 * hot); factor(f, .5 + 1.5 * hot);});
    const reveal = 98 * easeOut(prog(l3, .3, 3.2)) + (l3 < 0 ? 98 : 0);
    let k = 0;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++, k++) {
      const v = c <= reveal ? melV[c * ROWS + r] * (.92 + .08 * Math.sin(lt * 4 + c * .3)) : .02;
      s.set(.085, .145, .06 + v * 1.1);
      m4.compose(tmp.set(X[2] - 4.5 + c * .0928, -2 + r * .155, s.z / 2), q, s);
      mel.setMatrixAt(k, m4);
      const [rr, gg, bb] = jet(v);
      col.setRGB(rr * .85, gg * .85, bb * .85);
      mel.setColorAt(k, col);
    }
    mel.instanceMatrix.needsUpdate = true;
    mel.instanceColor.needsUpdate = true;
    // 04 · 05
    for (let i = 0; i < 500; i++) {
      const st = i % 2, u = frac(fSeed[i] + lt * .4), cx = X[3 + st];
      const spread = 1 - u * .8;
      feat.pos.set([cx - 4.6 + u * 8.6, .7 + fOff[i * 2] * 3 * spread, fOff[i * 2 + 1] * 3 * spread], i * 3);
      feat.al[i] = Math.sin(u * Math.PI);
      const c2 = st ? cB : cA;
      feat.col.set([c2.r, c2.g, c2.b], i * 3);
    }
    feat.commit();
    s1.rotation.y = Math.sin(lt * .5) * .12;
    s2.rotation.y = Math.sin(lt * .5 + 1) * .12;
    windows.forEach((w, i) => {w.position.x = X[4] - 5.6 + Math.sin(lt * 1.5 + i) * .15;});
    // 06
    const l6 = lt - 5 * S, draw = easeOut(prog(l6, .3, 1.3));
    checkBars[0].scale.x = Math.max(.001, checkBars[0].userData.len * clamp(draw * 2.6));
    checkBars[1].scale.x = Math.max(.001, checkBars[1].userData.len * clamp(draw * 1.6 - .6));
    okBurst.forEach((m, i) => {const kk = frac(lt * .6 + i / 2); m.scale.setScalar(2.4 + kk * 3.5); m.quaternion.copy(camera.quaternion); factor(m, Math.pow(1 - kk, 2) * smooth(prog(l6, .8, 1.4)));});
    okRing.rotation.z = lt * .2;
    // 07
    cloud.rotation.y = Math.sin(lt * .4) * .3;
    for (let i = 0; i < 220; i++) {
      const u = frac(uSeed[i] + lt * .45);
      up.pos.set([X[6] + uOff[i] * 2.4, lerp(-2.2, 1.4, u), Math.sin(u * 9 + i) * .4], i * 3);
      up.al[i] = Math.sin(u * Math.PI);
    }
    up.commit();
    // 08
    const l8 = lt - 7 * S, text = 'What is the weather?', n = Math.round(text.length * easeOut(prog(l8, .3, 2)));
    oled.userData.show(l8 < .3 ? ['MARVIN', 'LISTENING'] : ['TRANSCRIPT', text.slice(0, Math.min(n, 11)), n > 11 ? text.slice(11, n) : ''], Math.floor(lt * 2) % 2 === 0 && n < text.length);
    dash.position.y = 1.3 + Math.sin(lt * .8) * .12;
    // Flow
    for (let i = 0; i < FN; i++) {
      const u = frac(pSeed[i] + lt * .03);
      path.getPoint(u, tmp);
      F.pos.set([tmp.x, tmp.y + pOff[i * 2] * .8, tmp.z + pOff[i * 2 + 1] * .8], i * 3);
      F.al[i] = .7;
      col.copy(u < .43 ? cA : u < .7 ? cB : cC);
      F.col.set([col.r, col.g, col.b], i * 3);
    }
    F.commit();
  }};
}

// ---------- scene 4 · robustness ----------
const NEG = [['MARGIN', 0x8fb4ff, 3.4], ['MARINE', COL.violet, -3.4], ['NINE', COL.green, 1.7], ['MARTIN', COL.orange, -1.7]];
const GATE_X = 4.5, LANE_FROM = -11;
function buildRobust() {
  const g = new THREE.Group();
  const gate = new THREE.Group();
  gate.position.x = GATE_X;
  gate.rotation.y = Math.PI / 2;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(5, .14, 12, 160), basic(COL.violet, .9));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(4.9, 96), basic(COL.violet, .07));
  const flash = new THREE.Mesh(new THREE.CircleGeometry(4.9, 96), basic(COL.red, .5));
  const pass = new THREE.Mesh(new THREE.CircleGeometry(4.9, 96), basic(COL.green, .5));
  gate.add(ring, disc, flash, pass);
  g.add(gate);
  anchor(g, 'rb-gate', GATE_X, 6, 0);
  const ribbons = [...NEG.map(([w, c, y]) => ({word: w, color: c, y, t0: .9 + NEG.findIndex(n => n[0] === w) * .75, ok: false})), {word: 'MARVIN', color: COL.cyan, y: 0, t0: 4.5, ok: true}];
  const RN = 200;
  ribbons.forEach((rb, i) => {
    rb.P = makePoints(RN);
    for (let k = 0; k < RN; k++) {rb.P.sz[k] = .18; rb.P.setColor(k, rb.color);}
    g.add(rb.P.points);
    rb.anchor = anchor(g, `rb-${i}`, 0, 0, 0);
  });
  const noise = makePoints(500), nr = rng(61), nSeed = new Float32Array(1500);
  for (let i = 0; i < 1500; i++) nSeed[i] = nr();
  for (let i = 0; i < 500; i++) {noise.sz[i] = .1; noise.setColor(i, 0x9fb3c8, .8);}
  g.add(noise.points);
  const green = new THREE.Color(COL.green);
  return {group: g, update(lt) {
    let flashK = 0;
    ribbons.forEach(rb => {
      const travel = rb.ok ? 2.4 : 1.6, head = lerp(LANE_FROM, rb.ok ? 13 : GATE_X, easeOut(prog(lt, rb.t0, rb.t0 + travel)) * (rb.ok ? 1 : 1));
      const hit = rb.t0 + travel, after = lt - hit, started = lt > rb.t0;
      const fade = rb.ok ? 1 : 1 - smooth(prog(after, 0, .7));
      if (!rb.ok && after > 0 && after < .6) flashK = Math.max(flashK, 1 - after / .6);
      for (let k = 0; k < RN; k++) {
        const u = k / (RN - 1), x = head - u * 6.5;
        const amp = Math.sin(u * Math.PI) * (rb.ok ? 1.1 : .8);
        let y = rb.y + amp * Math.sin(u * 34 + lt * 9 + rb.y);
        let z = 0;
        if (!rb.ok && after > 0) {const sc = after * 4; y += (frac(Math.sin(k * 12.3) * 999) - .5) * sc; z = (frac(Math.sin(k * 7.7) * 999) - .5) * sc;}
        rb.P.pos.set([Math.min(x, rb.ok ? 99 : GATE_X), y, z], k * 3);
        rb.P.al[k] = started ? fade * (x > LANE_FROM - .5 ? 1 : 0) : 0;
        if (rb.ok && x > GATE_X) rb.P.col.set([green.r, green.g, green.b], k * 3);
      }
      rb.P.commit();
      rb.anchor.position.set(head - 3.2, rb.y + 1.25, 0);
    });
    const passK = smooth(prog(lt, 6.1, 6.5)) * (1 - smooth(prog(lt, 7, 8)));
    factor(flash, flashK);
    factor(pass, passK);
    for (let i = 0; i < 500; i++) {
      const u = frac(nSeed[i] + lt * (.08 + nSeed[i + 500] * .1));
      noise.pos.set([lerp(LANE_FROM - 2, GATE_X + 9, u), (nSeed[i + 1000] - .5) * 9, Math.sin(i + lt) * 1.5], i * 3);
      noise.al[i] = .35 * Math.sin(u * Math.PI);
    }
    noise.commit();
  }};
}

// ---------- gauges (model performance) ----------
const PERF = [[99.5, COL.blue], [95.9, COL.cyan], [95.1, COL.violet], [95.5, COL.green]];
// Edge compliance: every target is met, so each ring fills completely.
const EDGE = [[100, COL.cyan], [100, COL.violet], [100, COL.green], [100, COL.blue]];
const PERF_X = [-15.75, -5.25, 5.25, 15.75], PERF_R = 4;
const buildModelPerf = () => buildGauges(PERF, 'mp');
const buildEdgePerf = () => buildGauges(EDGE, 'ep', 'et');
function buildGauges(list, key, targetKey) {
  const g = new THREE.Group();
  const gauges = list.map(([v, color], i) => {
    const grp = new THREE.Group();
    grp.position.set(PERF_X[i], 0, 0);
    grp.rotation.y = -PERF_X[i] * .01;
    const track = new THREE.Mesh(new THREE.TorusGeometry(PERF_R, .18, 12, 180), basic(0x2b4a78, .6, {blending: THREE.NormalBlending}));
    const arc = new THREE.Mesh(new THREE.BufferGeometry(), basic(color, .8));
    arc.rotation.z = Math.PI / 2; arc.scale.x = -1;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(PERF_R - .3, 96), new THREE.MeshBasicMaterial({color: 0x0f2244, transparent: true, opacity: .85, depthWrite: false}));
    disc.position.z = -.1;
    const head = glowSprite(color, 2.6, 1);
    const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(.05, .3, .05), basic(0x9fc4e0, .45), 60);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let k = 0; k < 60; k++) {
      const a = k / 60 * Math.PI * 2;
      q.setFromAxisAngle(new V3(0, 0, 1), a);
      m4.compose(new V3(Math.cos(a + Math.PI / 2) * (PERF_R + .75), Math.sin(a + Math.PI / 2) * (PERF_R + .75), 0), q, new V3(1, k % 5 ? 1 : 1.8, 1));
      ticks.setMatrixAt(k, m4);
    }
    grp.add(disc, track, arc, ticks, head);
    g.add(grp);
    anchor(g, `${key}${i}`, PERF_X[i], .1, .3);
    if (targetKey) anchor(g, `${targetKey}${i}`, PERF_X[i], -PERF_R - 1.6, .3);
    return {arc, head, v};
  });
  return {group: g, update(lt) {
    gauges.forEach(({arc, head, v}, i) => {
      const p = easeOut(prog(lt, 1.4 + i * .35, 3.6 + i * .35)) * v / 100;
      arc.geometry.dispose();
      arc.geometry = new THREE.TorusGeometry(PERF_R, .28, 16, 220, Math.max(.001, p * Math.PI * 2));
      const a = Math.PI / 2 - p * Math.PI * 2;
      head.position.set(Math.cos(a) * PERF_R, Math.sin(a) * PERF_R, .1);
      factor(head, p > .002 ? 1 : 0);
    });
  }};
}

// ---------- scene 7 · viability (scalability tower) ----------
function buildViability() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, .3, 6), basic(0x6f9dff, .18));
  base.position.y = -.3;
  g.add(base, new THREE.LineSegments(new THREE.EdgesGeometry(base.geometry), lineMat(COL.cyan, .6)).translateY(-.3));
  const colors = [COL.cyan, COL.blue, COL.violet, COL.green];
  const slabs = colors.map((c, i) => {
    const grp = new THREE.Group();
    const geo = new THREE.BoxGeometry(8 - i * .9, .95, 4.6 - i * .5);
    grp.add(new THREE.Mesh(geo, basic(c, .22)), new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMat(c, .95)));
    g.add(grp);
    anchorOn(grp, `vb${i}`, 0, -.2, 2.4 - i * .25);
    return grp;
  });
  const beacon = glowSprite(COL.green, 4, .6);
  g.add(beacon);
  const apps = Array.from({length: 6}, (_, i) => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(.45, 1), basic([COL.cyan, COL.violet, COL.green, COL.blue, COL.orange, COL.cyan][i], .5, {wireframe: true}));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(), new V3()]), lineMat(COL.green, .5));
    g.add(m, line);
    return {m, line};
  });
  return {group: g, update(lt) {
    slabs.forEach((s, i) => {
      const k = easeOut(prog(lt, 1 + i * .55, 1.9 + i * .55));
      s.position.y = i * 1.25 + (1 - k) * 7;
      s.rotation.y = (1 - k) * .8 + Math.sin(lt * .4) * .06;
      factor(s.children[0], k); factor(s.children[1], k);
      s.visible = k > .01;
    });
    const top = 3 * 1.25 + .6, on = smooth(prog(lt, 3.7, 4.5));
    beacon.position.set(0, top + .3, 0);
    factor(beacon, on);
    apps.forEach(({m, line}, i) => {
      const a = i / 6 * Math.PI * 2 + lt * .35, r = 5.5 * on;
      m.position.set(Math.cos(a) * r, top + 2.2 + Math.sin(lt + i) * .3, Math.sin(a) * r);
      m.rotation.set(lt, lt * .7, 0);
      factor(m, on);
      line.geometry.setFromPoints([new V3(0, top + .3, 0), m.position]);
      factor(line, on * .8);
    });
  }};
}

// ---------- scene 8 · impact (globe) ----------
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
    P.setColor(i, land ? 0x7ee8ff : 0x6f8fff);
  }
  P.commit();
  const occluder = new THREE.Mesh(new THREE.SphereGeometry(R * .985, 64, 32), new THREE.MeshBasicMaterial({color: 0x0c1c3a, transparent: true, opacity: .92}));
  const wire = new THREE.Mesh(new THREE.SphereGeometry(R * 1.002, 36, 18), basic(0x6f9dff, .1, {wireframe: true}));
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
  g.add(glowSprite(0x6f9dff, 30, .35), globe);
  const orbit = new THREE.Group();
  orbit.rotation.set(1.15, 0, .35);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(10.5, .03, 6, 260), basic(COL.cyan, .5));
  const sat = new THREE.Group();
  const panelMat = new THREE.MeshBasicMaterial({color: 0x5f8dff});
  for (const s of [-1, 1]) {const pn = new THREE.Mesh(new THREE.BoxGeometry(1.6, .04, .6), panelMat); pn.position.x = s * 1.15; sat.add(pn);}
  sat.add(new THREE.Mesh(new THREE.BoxGeometry(.6, .6, .8), new THREE.MeshBasicMaterial({color: 0xd9b45a})), glowSprite(0xffffff, 1.8, .7));
  orbit.add(ring, sat);
  g.add(orbit);
  const links = CARD_POS.map(([x, y, z], i) => {
    const a = new V3(x, y, z), b = a.clone().normalize().multiplyScalar(R + .2);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([b, a]), lineMat(COL.cyan, .7));
    const dot = glowSprite(COL.cyan, 1.3, 1);
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
    links.forEach(({line, dot}, i) => {const k = smooth(prog(lt, 2.6 + i * .5, 3.3 + i * .5)); factor(line, k); factor(dot, k);});
  }};
}

// ---------- scene 9 · closing ----------
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
    orb.update(lt + 20, Math.exp(-Math.pow(lt - .8, 2) / .3) * .9);
    const grow = easeOut(prog(lt, 0, 3));
    for (let i = 0; i < N; i++) {
      const th = th0[i] + lt * 1.4 / Math.sqrt(rad[i]), R = rad[i] * (.25 + .75 * grow);
      P.pos.set([Math.cos(th) * R, yy[i], Math.sin(th) * R], i * 3);
      P.al[i] = grow * (.6 + .4 * Math.sin(lt * 2 + i));
    }
    P.commit();
  }};
}

// ---------- scene · why we stand out ----------
const UNIQ_X = [-14.5, 0, 14.5];
function numberTexture(n, accent) {
  return canvasTexture(512, 512, (x, w, h) => {
    const g = x.createRadialGradient(256, 230, 20, 256, 256, 256);
    g.addColorStop(0, 'rgba(40,70,130,.95)'); g.addColorStop(1, 'rgba(12,24,52,.95)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = accent; x.textAlign = 'center'; x.font = '700 300px "Space Grotesk"'; x.fillText(n, 256, 360);
  });
}
function buildUnique() {
  const g = new THREE.Group();
  const accents = [['#9eefff', COL.cyan], ['#d2bcff', COL.violet], ['#a8f7d4', COL.green]];
  const meds = UNIQ_X.map((x, i) => {
    const m = new THREE.Group();
    m.position.set(x, 3.2, 0);
    const prism = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, .55, 6), basic(accents[i][1], .16));
    prism.rotation.x = Math.PI / 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(prism.geometry), lineMat(accents[i][1], .95));
    edges.rotation.x = Math.PI / 2;
    const faceGeo = new THREE.CircleGeometry(2.05, 6);
    faceGeo.rotateZ(Math.PI / 2);
    const fp = faceGeo.attributes.position, fuv = faceGeo.attributes.uv;
    for (let v = 0; v < fp.count; v++) fuv.setXY(v, fp.getX(v) / 4.1 + .5, fp.getY(v) / 4.1 + .5);
    const face = new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({map: numberTexture(String(i + 1), accents[i][0]), color: new THREE.Color(.85, .85, .85), transparent: true}));
    face.position.z = .29;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.1, .04, 8, 160), basic(accents[i][1], .7));
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(3.45, .025, 8, 160), basic(accents[i][1], .4));
    m.add(glowSprite(accents[i][1], 11, .45), prism, edges, face, ring, ring2);
    g.add(m);
    anchor(g, `uq${i}`, x, -.2, 0);
    return {m, ring, ring2};
  });
  const sp = makePoints(420), r = rng(71), sSeed = new Float32Array(420);
  for (let i = 0; i < 420; i++) {sSeed[i] = r(); sp.sz[i] = .1 + r() * .12; sp.setColor(i, accents[i % 3][1]);}
  g.add(sp.points);
  return {group: g, update(lt) {
    meds.forEach(({m, ring, ring2}, i) => {
      const k = easeOut(prog(lt, .6 + i * .4, 1.8 + i * .4));
      m.scale.setScalar(.3 + .7 * k);
      m.rotation.y = (1 - k) * 3 + Math.sin(lt * .8 + i) * .22;
      m.position.y = 3.2 + Math.sin(lt * 1.1 + i) * .2;
      ring.rotation.set(1.2 + Math.sin(lt * .5 + i) * .2, lt * .6, 0);
      ring2.rotation.set(-1.0, -lt * .4, .3);
      m.visible = k > .01;
    });
    for (let i = 0; i < 420; i++) {
      const c = i % 3, a = sSeed[i] * 6.28 + lt * (.3 + sSeed[i] * .3), rad = 3.6 + sSeed[(i * 7) % 420] * 1.5;
      sp.pos.set([UNIQ_X[c] + Math.cos(a) * rad, 3.2 + Math.sin(a) * rad, Math.sin(a * 2 + i) * .6], i * 3);
      sp.al[i] = .5 * smooth(prog(lt, .8 + c * .4, 2 + c * .4));
    }
    sp.commit();
  }};
}

// ---------- scene · dashboard (real screenshot shown flat in the DOM) ----------
function buildDashBg() {
  const g = new THREE.Group();
  const glowA = glowSprite(0x6f9dff, 60, .35), glowB = glowSprite(COL.violet, 40, .25);
  glowA.position.set(0, 2, -14); glowB.position.set(14, -4, -18);
  g.add(glowA, glowB);
  return {group: g, update(lt) {glowA.position.x = Math.sin(lt * .3) * 3;}};
}

// ---------- scene · tech stack ----------
const TECH = ['ESP32', 'INMP441', 'OLED SSD1306', 'Log-Mel 98×24', 'TFLite Micro', 'Python', 'TensorFlow', 'Arduino IDE', 'MATLAB', 'React', 'VS Code', 'Cloud ASR'];
function tileTexture(text, accent) {
  return canvasTexture(640, 200, (x, w, h) => {
    x.beginPath(); x.roundRect(6, 6, w - 12, h - 12, 40);
    x.fillStyle = 'rgba(16,34,70,0.94)'; x.fill();
    x.lineWidth = 6; x.strokeStyle = accent; x.stroke();
    x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.font = `700 ${text.length > 11 ? 60 : 72}px "Space Grotesk"`; x.fillText(text, w / 2, 126);
  });
}
function buildTechStack() {
  const g = new THREE.Group();
  const chip = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, .7, 4.4), std(0x10141c, .3, .45));
  const top = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 4.1), new THREE.MeshBasicMaterial({map: canvasTexture(512, 512, (x, w, h) => {
    x.fillStyle = '#141a26'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#7ee8ff'; x.lineWidth = 6; x.strokeRect(30, 30, w - 60, h - 60);
    x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.font = '700 92px "Space Grotesk"'; x.fillText('MARVIN', 256, 250);
    x.fillStyle = '#9eefff'; x.font = '600 46px "Space Grotesk"'; x.fillText('TinyML · INT8', 256, 330);
  }), color: new THREE.Color(.9, .9, .9)}));
  top.rotation.x = -Math.PI / 2; top.position.y = .36;
  chip.add(body, top, new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), lineMat(COL.cyan, .8)));
  for (let s = 0; s < 4; s++) for (let k = 0; k < 9; k++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(.18, .12, .6), std(0xd9b45a, 1, .3));
    const off = -1.8 + k * .45, a = s * Math.PI / 2;
    p.position.set(Math.cos(a) * 2.5 + Math.sin(a) * off, -.15, Math.sin(a) * 2.5 + Math.cos(a) * off);
    p.rotation.y = -a + Math.PI / 2;
    chip.add(p);
  }
  chip.add(glowSprite(COL.cyan, 14, .45));
  g.add(chip);
  const orbit = new THREE.Group();
  orbit.rotation.set(.38, 0, -.08);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(7.2, .04, 8, 220), basic(COL.cyan, .5));
  ring.rotation.x = Math.PI / 2;
  orbit.add(ring);
  const accents = ['#9eefff', '#d2bcff', '#a8f7d4', '#b9d2ff'];
  const tiles = TECH.map((t, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.125), new THREE.MeshBasicMaterial({map: tileTexture(t, accents[i % 4]), transparent: true, depthWrite: false, color: new THREE.Color(.92, .92, .92)}));
    orbit.add(m);
    return m;
  });
  g.add(orbit);
  return {group: g, update(lt) {
    chip.rotation.y = lt * .25;
    chip.position.y = Math.sin(lt * .9) * .2;
    const spread = easeOut(prog(lt, .5, 2.2));
    tiles.forEach((m, i) => {
      const a = i / TECH.length * Math.PI * 2 + lt * .16;
      m.position.set(Math.cos(a) * 7.2 * spread, Math.sin(lt + i) * .25, Math.sin(a) * 7.2 * spread);
      m.quaternion.copy(camera.quaternion);
      orbit.updateMatrixWorld();
      const parentQ = new THREE.Quaternion();
      orbit.getWorldQuaternion(parentQ);
      m.quaternion.premultiply(parentQ.invert());
      factor(m, spread);
    });
  }};
}

// ---------- timeline ----------
function orbitPose(c, r, h, a, shift = 0, lookY = 0) {
  const right = new V3(Math.cos(a), 0, -Math.sin(a));
  const pos = new V3(c.x + Math.sin(a) * r, c.y + h, c.z + Math.cos(a) * r).addScaledVector(right, -shift);
  const look = new V3(c.x, c.y + lookY, c.z).addScaledVector(right, -shift);
  return [pos, look];
}
// d0 = the duration each scene was designed for; it is played back in (end - start) seconds.
const IMPACT_SCENES = [
  {start: 0, d0: 6, build: buildIntro, cam: lt => [new V3(6 * Math.sin(lt * .12), 2 + 1.2 * Math.cos(lt * .1), lerp(90, 40, easeOut(prog(lt, 0, 5.5)))), new V3(0, -6.2, 0)]},
  {start: 5, d0: 8, build: buildTechStack, cam: lt => orbitPose(new V3(0, .5, 0), 27, 6, -.15 + lt * .02, 8.6, .3)},
  {start: 12, d0: 9, build: buildViability, cam: lt => orbitPose(new V3(0, 2.6, 0), 28, 5, -.3 + lt * .03, 8, -3)},
  {start: 21, d0: 8, build: buildImpact, cam: lt => orbitPose(new V3(0, 0, 0), 34, 3, -.1 + lt * .014, 4.6, .2)},
  {start: 29, d0: 7, build: buildUnique, cam: lt => [new V3(Math.sin(lt * .07) * 2, 4.5, lerp(39, 36.5, ease(prog(lt, 0, 7)))), new V3(0, .2, 0)]},
  {start: 36, d0: 8, build: buildDashBg, cam: lt => [new V3(0, 2, 30 - lt * .3), new V3(0, 1, 0)]},
  {start: 44, d0: 6, build: buildOutro, cam: lt => [new V3(8 * Math.sin(lt * .06), 4, lerp(38, 44, easeOut(prog(lt, 0, 6)))), new V3(0, -6.4, 0)]},
];
const SCENES = CUT === 'impact' ? IMPACT_SCENES : [
  {start: 0, d0: 8, build: buildIntro, cam: lt => [new V3(6 * Math.sin(lt * .12), 2 + 1.2 * Math.cos(lt * .1), lerp(90, 40, easeOut(prog(lt, 0, 7)))), new V3(0, -6.2, 0)]},
  {start: 6, d0: 11, build: buildProblem, cam: lt => orbitPose(new V3(2.5, 1, 0), 30.5, 4.5, -.2 + lt * .02, 10, .4)},
  {start: 15, d0: 12, build: buildPrototype, cam: lt => orbitPose(new V3(4.4, .3, 0), 23.5, 5.5, PROTO_CAM_A(lt), 8.2, .8)},
  {start: 30, d0: 10, build: buildUnique, cam: lt => [new V3(Math.sin(lt * .07) * 2, 4.5, lerp(39, 36.5, ease(prog(lt, 0, 10)))), new V3(0, .2, 0)]},
  {start: 38, d0: 12, build: buildDashBg, cam: lt => [new V3(0, 2, 30 - lt * .3), new V3(0, 1, 0)]},
  {start: 50, d0: 32, build: buildWorkflow, cam: lt => {const x = flowFocus(lt); return [new V3(x - 2.5, 3.4, 21.5), new V3(x, .9, 0)];}},
  {start: 78, d0: 9, build: buildRobust, cam: lt => orbitPose(new V3(1, 0, 0), 30, 3.5, -.12 + lt * .02, 7.5, 0)},
  {start: 85, d0: 25, build: buildDashBg, cam: lt => [new V3(0, 2, 30 - lt * .12), new V3(0, 1, 0)]},
  {start: 110, d0: 10, build: buildModelPerf, cam: lt => [new V3(Math.sin(lt * .06) * 3, 3, lerp(50, 45, ease(prog(lt, 0, 10)))), new V3(0, 1.6, 0)]},
  {start: 118, d0: 11, build: buildEdgePerf, cam: lt => [new V3(Math.sin(lt * .06) * 3, 3, lerp(50, 45, ease(prog(lt, 0, 11)))), new V3(0, 1.6, 0)]},
  {start: 129, d0: 6, build: buildOutro, cam: lt => [new V3(8 * Math.sin(lt * .06), 4, lerp(38, 44, easeOut(prog(lt, 0, 6)))), new V3(0, -6.4, 0)]},
];
SCENES.forEach((s, i) => {s.end = SCENES[i + 1]?.start ?? DURATION; s.origin = new V3(0, 0, -i * 150); s.k = s.d0 / (s.end - s.start);});
const localT = (s, t) => (t - s.start) * s.k;

const pose = (i, t) => {const s = SCENES[i], [p, l] = s.cam(localT(s, t)); return [p.add(s.origin), l.add(s.origin)];};
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
    const s = SCENES[+sec.dataset.s], lt = localT(s, t);
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
      const anchorShift = pin ? (pin.classList.contains('mid') ? 'translate(-50%,-50%) ' : pin.classList.contains('top') ? 'translate(-50%,0) ' : 'translate(-50%,-100%) ') : '';
      if (el.dataset.fade !== undefined) {el.style.opacity = a * o; el.style.transform = 'none'; el.style.filter = 'none'; continue;}
      el.style.transform = el.dataset.tilt !== undefined ? `perspective(1800px) rotateX(${((1 - a) * 22).toFixed(2)}deg) scale(${(.9 + .1 * a).toFixed(4)})` : `${anchorShift}translateY(${((1 - a) * 34).toFixed(2)}px)`;
      el.style.filter = a < .999 ? `blur(${((1 - a) * 10).toFixed(2)}px)` : 'none';
    }
    for (const el of sec.querySelectorAll('[data-count]')) {
      const k = easeOut(prog(lt, +el.dataset.cin, +el.dataset.cin + 1.8)), dec = +(el.dataset.dec || 0);
      el.textContent = `${el.dataset.prefix || ''}${(+el.dataset.count * k).toFixed(dec)}${el.dataset.suffix || ''}`;
    }
    for (const el of sec.querySelectorAll('[data-flow]')) el.style.backgroundPositionX = `${(lt * +el.dataset.flow).toFixed(1)}px`;
    for (const el of sec.querySelectorAll('[data-type]')) {
      const txt = el.dataset.type, k = prog(lt, +el.dataset.tin, +el.dataset.tin + +(el.dataset.tdur || 1.6));
      el.textContent = txt.slice(0, Math.round(txt.length * k)) || ' ';
    }
  }
  leftshade.style.opacity = shade;
  for (const pin of pins) {
    const a = anchors[pin.dataset.pin];
    if (!a || pin.closest('.sec').style.opacity === '0') continue;
    a.getWorldPosition(proj).project(camera);
    pin.style.transform = `translate(${((proj.x + 1) / 2 * W).toFixed(1)}px, ${((1 - proj.y) / 2 * H).toFixed(1)}px)`;
  }
  fadeEl.style.background = t < 10 ? '#ffffff' : '#000000';
  fadeEl.style.opacity = Math.max(1 - smooth(prog(t, 0, 1.0)), smooth(prog(t, DURATION - 1.4, DURATION - .05)));
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
  stars.points.visible = false; dust.points.visible = false;
  bokeh.position.copy(camera.position).multiplyScalar(.82);
  bokeh.children.forEach((sp, i) => {const [bx, by, bz, ph, sp2] = bokehSeeds[i]; sp.position.set(bx + Math.sin(t * .05 * sp2 + ph) * 6 + camera.position.x * .18, by + Math.cos(t * .04 * sp2 + ph) * 3 + camera.position.y * .18, bz + camera.position.z * .18);});
  stars.points.rotation.y = t * .006;
  twinkle(t);
  terrain.position.set(0, camera.position.y - 15, camera.position.z - 30);
  terrainUniforms.uTime.value = t;
  terrainUniforms.uOffset.value = terrain.position.z;
  SCENES.forEach((s, i) => {
    const a = Math.min(smooth(prog(t, s.start - .55, s.start + .6)), s.end >= DURATION ? 1 : 1 - smooth(prog(t, s.end - .6, s.end + .55)));
    const sc = built[i];
    if (a > .003) sc.update(localT(s, t));
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
const loadTex = async url => {const t = await new THREE.TextureLoader().loadAsync(url); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;};
const TEX = {proto: await loadTex('assets/prototype_land.jpg'), dash: await loadTex('assets/dash-live-monitor.jpg')};
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

if (new URLSearchParams(location.search).has('play')) {
  const t0 = performance.now(), from = +(new URLSearchParams(location.search).get('t') || 0);
  const loop = () => {renderFrame((from + (performance.now() - t0) / 1000) % DURATION); requestAnimationFrame(loop);};
  loop();
}
