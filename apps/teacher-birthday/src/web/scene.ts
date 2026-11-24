/**
 * 生日派对 3D 场景：带滴落淋面和裱花的双层蛋糕、气球、彩旗、串灯、持续飘落的彩纸。
 * 场景铺满整页背景，镜头跟着页面滚动连续移动（不切场景）：顶部看蛋糕 → 往下读祝福时镜头上移到气球彩旗 →
 * 读到寄语时推近烛光。WebGLRenderer 创建失败时直接抛出，由调用方降级。
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export interface SceneHandle {
  /** 拆信后：镜头从高处俯冲到蛋糕前，彩纸礼炮 */
  intro(): void;
  /** 再放一次彩纸礼炮 */
  burst(): void;
  dispose(): void;
}

/**
 * 系统开了「减少动态效果」时：去掉镜头俯冲、滚动惯性和礼炮这类大幅运动；
 * 气球、烛火、彩旗、串灯、彩纸这些氛围动画保留但放慢——它们就是这一页的内容本身。
 */
const CALM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const AMBIENT = CALM ? 0.55 : 1;
const PARTY = [0xffc56b, 0xff8fa3, 0xb9a6ff, 0x7fd8c3, 0x8cc8ff, 0xfff1d6];

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const glow = (inner: string, outer: string) =>
  canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(0.3, outer);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });

/** 侧面带圆角的蛋糕层（车削体） */
function tierGeometry(radius: number, height: number, bevel: number): THREE.LatheGeometry {
  const points = [new THREE.Vector2(0, 0), new THREE.Vector2(radius - 0.02, 0), new THREE.Vector2(radius, 0.02), new THREE.Vector2(radius, height - bevel)];
  for (let i = 1; i <= 8; i += 1) {
    const a = (i / 8) * (Math.PI / 2);
    points.push(new THREE.Vector2(radius - bevel + Math.cos(a) * bevel, height - bevel + Math.sin(a) * bevel));
  }
  points.push(new THREE.Vector2(0, height));
  return new THREE.LatheGeometry(points, 128);
}

/** 顶部一圈往下滴的淋面：圆柱侧面按角度给出不同的滴落长度 */
function dripGeometry(radius: number, random: () => number): THREE.CylinderGeometry {
  const drips = Array.from({ length: 22 }, () => ({ angle: random() * Math.PI * 2, length: 0.12 + random() * 0.38, width: 0.05 + random() * 0.06 }));
  const lengthAt = (angle: number) => {
    let extra = 0;
    for (const drip of drips) {
      let d = Math.abs(angle - drip.angle);
      d = Math.min(d, Math.PI * 2 - d);
      extra = Math.max(extra, drip.length * Math.exp(-((d / drip.width) ** 2)));
    }
    return 0.1 + extra;
  };
  const geometry = new THREE.CylinderGeometry(radius, radius, 1, 192, 12, true);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const t = 0.5 - position.getY(i); // 0 = 顶边, 1 = 底边
    const angle = Math.atan2(z, x) + Math.PI;
    const bulge = 1 + 0.012 * t ** 4;
    position.setXYZ(i, x * bulge, -t * lengthAt(angle), z * bulge);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** 星形裱花嘴挤出的奶油花：球体按角度做出棱纹和旋转 */
function rosetteGeometry(size: number): THREE.SphereGeometry {
  const geometry = new THREE.SphereGeometry(size, 32, 20);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i).divideScalar(size);
    const theta = Math.atan2(v.z, v.x) + v.y * 2.2;
    const ridge = 1 + 0.16 * Math.max(0, Math.cos(theta * 8)) * (1 - Math.abs(v.y) * 0.6);
    v.multiplyScalar(size * ridge);
    v.y = v.y * 0.85 + (v.y > 0 ? v.y * v.y * 0.6 : 0);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** 覆盆子：小球表面一颗颗鼓起 */
function berryGeometry(size: number): THREE.SphereGeometry {
  const geometry = new THREE.SphereGeometry(size, 28, 20);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i).normalize();
    const bump = Math.abs(Math.sin(v.x * 9) * Math.sin(v.y * 9) * Math.sin(v.z * 9));
    v.multiplyScalar(size * (1 + bump * 0.14));
    v.y *= 1.12;
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function balloonGeometry(): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    const y = -Math.cos(Math.PI * t) * 0.62;
    const x = Math.sin(Math.PI * t) * 0.46 * (0.62 + 0.38 * Math.sin((Math.PI * t) / 2));
    points.push(new THREE.Vector2(Math.max(0.001, x), y));
  }
  return new THREE.LatheGeometry(points, 48);
}

export function createScene(canvas: HTMLCanvasElement, opts: { candles: number; name: string }): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(item: T) => (disposables.push(item), item);
  const random = seeded([...opts.name].reduce((sum, ch) => (sum * 31 + ch.codePointAt(0)!) >>> 0, 11));

  const scene = new THREE.Scene();
  scene.background = keep(
    canvasTexture(4, 256, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, "#2d2257");
      g.addColorStop(0.55, "#1b1640");
      g.addColorStop(1, "#0d0b1f");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4, 256);
    }),
  );
  const pmrem = keep(new THREE.PMREMGenerator(renderer));
  const room = new RoomEnvironment();
  scene.environment = keep(pmrem.fromScene(room, 0.04).texture);
  scene.environmentIntensity = 0.45;
  room.dispose();

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);

  // ---------- 灯光 ----------
  scene.add(new THREE.HemisphereLight(0xb9b0ff, 0x2a1f4a, 0.6));
  const key = new THREE.SpotLight(0xffe2c4, 16, 30, Math.PI / 6, 0.7, 1.4);
  key.position.set(3.5, 9, 6);
  key.target.position.set(0, 1.6, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xa58bff, 1.4);
  rim.position.set(-5, 4, -6);
  scene.add(rim);
  const candleLight = new THREE.PointLight(0xffb15c, 3, 6, 1.4);
  candleLight.position.set(0, 3.5, 0.3);
  scene.add(candleLight);

  // ---------- 材质 ----------
  const mat = {
    porcelain: keep(new THREE.MeshPhysicalMaterial({ color: 0xf7f4f0, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 })),
    gold: keep(new THREE.MeshStandardMaterial({ color: 0xe9c27a, metalness: 1, roughness: 0.22 })),
    pinkCream: keep(new THREE.MeshPhysicalMaterial({ color: 0xf6c9d0, roughness: 0.62, sheen: 0.7, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5 })),
    vanilla: keep(new THREE.MeshPhysicalMaterial({ color: 0xf3e8d8, roughness: 0.6, sheen: 0.6, sheenColor: new THREE.Color(0xfff6ea), sheenRoughness: 0.45 })),
    glaze: keep(new THREE.MeshPhysicalMaterial({ color: 0x9c1f47, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.06 })),
    whipped: keep(new THREE.MeshPhysicalMaterial({ color: 0xf8efe4, roughness: 0.62, sheen: 0.5, sheenColor: new THREE.Color(0xffffff) })),
    raspberry: keep(new THREE.MeshPhysicalMaterial({ color: 0xc8284f, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25 })),
    blueberry: keep(new THREE.MeshPhysicalMaterial({ color: 0x2c2f66, roughness: 0.45, sheen: 0.8, sheenColor: new THREE.Color(0x8a8fd8) })),
  };

  // ---------- 蛋糕台与蛋糕 ----------
  const cake = new THREE.Group();
  const stand = new THREE.Mesh(
    keep(
      new THREE.LatheGeometry(
        [
          [0, 0], [0.62, 0], [0.64, 0.04], [0.5, 0.1], [0.2, 0.22], [0.16, 0.7], [0.24, 0.8], [1.78, 0.84], [1.82, 0.88], [1.78, 0.9], [0, 0.9],
        ].map(([x, y]) => new THREE.Vector2(x, y)),
        96,
      ),
    ),
    mat.porcelain,
  );
  const rimRing = new THREE.Mesh(keep(new THREE.TorusGeometry(1.8, 0.022, 12, 128)), mat.gold);
  rimRing.rotation.x = Math.PI / 2;
  rimRing.position.y = 0.88;
  cake.add(stand, rimRing);

  const bottomTier = new THREE.Mesh(keep(tierGeometry(1.42, 1.0, 0.07)), mat.pinkCream);
  bottomTier.position.y = 0.9;
  const drip = new THREE.Mesh(keep(dripGeometry(1.425, random)), mat.glaze);
  drip.position.y = 1.9;
  const glazeCap = new THREE.Mesh(keep(new THREE.CircleGeometry(1.425, 128)), mat.glaze);
  glazeCap.rotation.x = -Math.PI / 2;
  glazeCap.position.y = 1.902;
  const topTier = new THREE.Mesh(keep(tierGeometry(0.98, 0.78, 0.06)), mat.vanilla);
  topTier.position.y = 1.9;
  cake.add(bottomTier, drip, glazeCap, topTier);

  // 裱花：下层边缘一圈小花、上层顶边一圈大花
  const rosette = keep(rosetteGeometry(0.1));
  for (const [radius, y, count, scale] of [[1.22, 1.93, 26, 0.85], [0.84, 2.7, 18, 1]] as const) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const r = new THREE.Mesh(rosette, mat.whipped);
      r.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      r.rotation.y = -angle;
      r.scale.setScalar(scale);
      cake.add(r);
    }
  }
  // 底边一圈金珠
  const pearl = keep(new THREE.SphereGeometry(0.045, 16, 12));
  for (let i = 0; i < 64; i += 1) {
    const angle = (i / 64) * Math.PI * 2;
    const p = new THREE.Mesh(pearl, mat.gold);
    p.position.set(Math.cos(angle) * 1.45, 0.94, Math.sin(angle) * 1.45);
    cake.add(p);
  }
  // 顶上的莓果与金珠
  const berry = keep(berryGeometry(0.085));
  const blue = keep(new THREE.SphereGeometry(0.06, 20, 14));
  const goldBead = keep(new THREE.SphereGeometry(0.03, 12, 10));
  for (let i = 0; i < 14; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 0.25 + random() * 0.45;
    const isBerry = i % 2 === 0;
    const m = new THREE.Mesh(isBerry ? berry : blue, isBerry ? mat.raspberry : mat.blueberry);
    m.position.set(Math.cos(angle) * radius, 2.68 + (isBerry ? 0.08 : 0.055), Math.sin(angle) * radius);
    m.rotation.set(random(), random(), random());
    cake.add(m);
  }
  for (let i = 0; i < 26; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 0.2 + random() * 0.6;
    const b = new THREE.Mesh(goldBead, mat.gold);
    b.position.set(Math.cos(angle) * radius, 2.69, Math.sin(angle) * radius);
    cake.add(b);
  }
  cake.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  // 螺旋条纹蜡烛 + 烛火（一直亮着）
  const stripe = keep(
    canvasTexture(64, 256, (ctx) => {
      ctx.fillStyle = "#fff8f0";
      ctx.fillRect(0, 0, 64, 256);
      ctx.fillStyle = "#f08aa0";
      for (let y = -64; y < 256; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(64, y + 32);
        ctx.lineTo(64, y + 46);
        ctx.lineTo(0, y + 14);
        ctx.fill();
      }
    }),
  );
  stripe.wrapS = stripe.wrapT = THREE.RepeatWrapping;
  const candleMat = keep(new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.45 }));
  const candleGeo = keep(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 20));
  const flameTex = keep(glow("rgba(255,248,225,1)", "rgba(255,170,60,0.9)"));
  const flames: THREE.Sprite[] = [];
  const candles = Math.max(1, Math.min(9, opts.candles));
  for (let i = 0; i < candles; i += 1) {
    const angle = (i / candles) * Math.PI * 2 + 0.4;
    const radius = candles === 1 ? 0 : 0.42;
    const c = new THREE.Mesh(candleGeo, candleMat);
    c.position.set(Math.cos(angle) * radius, 2.93, Math.sin(angle) * radius);
    c.castShadow = true;
    cake.add(c);
    const flameMat = keep(new THREE.SpriteMaterial({ map: flameTex, color: new THREE.Color(2.4, 1.7, 1.1), blending: THREE.AdditiveBlending, depthWrite: false }));
    const f = new THREE.Sprite(flameMat);
    f.position.set(c.position.x, 3.28, c.position.z);
    f.userData.x = c.position.x;
    f.scale.set(0.2, 0.32, 1);
    flames.push(f);
    cake.add(f);
  }
  scene.add(cake);

  // 地面接影 + 暖光晕
  const ground = new THREE.Mesh(keep(new THREE.CircleGeometry(6, 64)), keep(new THREE.ShadowMaterial({ opacity: 0.35 })));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const halo = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: keep(glow("rgba(255,190,120,0.22)", "rgba(180,120,255,0.08)")), depthWrite: false, blending: THREE.AdditiveBlending })));
  halo.scale.set(9, 6, 1);
  halo.position.set(0, 2, -2.5);
  scene.add(ground, halo);

  // ---------- 气球 ----------
  const balloonGeo = keep(balloonGeometry());
  const knotGeo = keep(new THREE.ConeGeometry(0.05, 0.08, 12));
  const stringMat = keep(new THREE.LineBasicMaterial({ color: 0xd8d0f0, transparent: true, opacity: 0.55 }));
  // off/vel：被鼠标推开后的弹簧偏移
  const balloons: Array<{ group: THREE.Group; offset: number; y: number; z: number; phase: number; side: number; off: THREE.Vector2; vel: THREE.Vector2; radius: number }> = [];
  // [左右, 离中线的额外距离, 高度, 深度, 大小]
  const balloonSpots = [
    [-1, 0, 0.2, 0, 1.0], [-1, 0.35, 0.9, -0.6, 0.9], [-1, -0.2, 1.3, -1.2, 0.85], [-1, 0.6, 1.8, -1.6, 1.05], [-1, 0.1, 2.4, -2.2, 0.8],
    [1, 0, 0.35, 0, 1.0], [1, 0.4, 1.0, -0.7, 0.92], [1, -0.15, 1.55, -1.3, 0.85], [1, 0.65, 2.0, -1.7, 1.0], [1, 0.15, 2.6, -2.4, 0.8],
  ];
  balloonSpots.forEach(([side, offset, y, z, scale], i) => {
    const material = keep(new THREE.MeshPhysicalMaterial({ color: PARTY[i % PARTY.length], roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12, sheen: 0.4, sheenColor: new THREE.Color(0xffffff) }));
    const group = new THREE.Group();
    const body = new THREE.Mesh(balloonGeo, material);
    const knot = new THREE.Mesh(knotGeo, material);
    knot.position.y = -0.64;
    const stringGeo = keep(
      new THREE.BufferGeometry().setFromPoints(
        new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.66, 0), new THREE.Vector3(0.06, -1.3, 0.02), new THREE.Vector3(-0.05, -2, 0), new THREE.Vector3(0.03, -2.8, 0)]).getPoints(24),
      ),
    );
    group.add(body, knot, new THREE.Line(stringGeo, stringMat));
    group.scale.setScalar(scale);
    balloons.push({ group, offset, y: 3.1 + y, z, phase: random() * Math.PI * 2, side, off: new THREE.Vector2(), vel: new THREE.Vector2(), radius: 0.75 * scale });
    scene.add(group);
  });

  // ---------- 彩旗与串灯（悬在蛋糕后上方的两条垂线） ----------
  const catenary = (y: number, z: number, sag: number, span: number) => (t: number) => new THREE.Vector3((t - 0.5) * span, y - sag * (1 - (2 * t - 1) ** 2), z);
  const flagGeo = keep(new THREE.BufferGeometry());
  flagGeo.setAttribute("position", new THREE.Float32BufferAttribute([-0.2, 0, 0, 0.2, 0, 0, 0, -0.42, 0], 3));
  flagGeo.computeVertexNormals();
  const flags: THREE.Mesh[] = [];
  const buntingAt = catenary(6.9, -4, 1.0, 14);
  for (let i = 0; i < 19; i += 1) {
    const flag = new THREE.Mesh(flagGeo, keep(new THREE.MeshStandardMaterial({ color: PARTY[i % PARTY.length], roughness: 0.7, side: THREE.DoubleSide })));
    flag.position.copy(buntingAt((i + 0.5) / 19));
    flag.userData = { phase: i * 0.7, swing: 0, swingVel: 0 };
    flags.push(flag);
    scene.add(flag);
  }
  scene.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 40 }, (_, i) => buntingAt(i / 39)))), stringMat));

  const lightsAt = catenary(7.9, -5.2, 1.4, 17);
  const bulbGeo = keep(new THREE.SphereGeometry(0.055, 12, 10));
  const bulbs: THREE.Mesh[] = [];
  for (let i = 0; i < 34; i += 1) {
    const bulb = new THREE.Mesh(bulbGeo, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd28a).multiplyScalar(3) })));
    bulb.position.copy(lightsAt((i + 0.5) / 34));
    bulb.userData.phase = random() * Math.PI * 2;
    bulbs.push(bulb);
    scene.add(bulb);
  }
  scene.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 48 }, (_, i) => lightsAt(i / 47)))), stringMat));

  // 远处星点
  const far = keep(new THREE.BufferGeometry());
  far.setAttribute("position", new THREE.Float32BufferAttribute(Array.from({ length: 1500 }, (_, i) => (i % 3 === 0 ? (random() - 0.5) * 70 : i % 3 === 1 ? random() * 30 + 2 : -18 - random() * 20)), 3));
  scene.add(new THREE.Points(far, keep(new THREE.PointsMaterial({ color: 0xd8d0ff, size: 0.08, transparent: true, opacity: 0.6, depthWrite: false }))));

  // ---------- 彩纸：常态缓缓飘落，礼炮时从两侧喷出 ----------
  const CONFETTI = 280;
  const confetti = new THREE.InstancedMesh(
    keep(new THREE.PlaneGeometry(0.07, 0.12)),
    keep(new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.25, side: THREE.DoubleSide })),
    CONFETTI,
  );
  const cPos = new Float32Array(CONFETTI * 3);
  const cVel = new Float32Array(CONFETTI * 3);
  const cRot = new Float32Array(CONFETTI * 3);
  const cSpin = new Float32Array(CONFETTI * 3);
  const color = new THREE.Color();
  const respawn = (i: number, anywhere: boolean) => {
    cPos.set([(random() - 0.5) * 14, anywhere ? random() * 9 : 9 + random() * 2, (random() - 0.5) * 8 - 1], i * 3);
    cVel.set([(random() - 0.5) * 0.2, -(0.35 + random() * 0.35), 0], i * 3);
  };
  for (let i = 0; i < CONFETTI; i += 1) {
    respawn(i, true);
    cRot.set([random() * 6, random() * 6, random() * 6], i * 3);
    cSpin.set([(random() - 0.5) * 6, (random() - 0.5) * 6, (random() - 0.5) * 3], i * 3);
    confetti.setColorAt(i, color.setHex(PARTY[i % PARTY.length]));
  }
  scene.add(confetti);
  const dummy = new THREE.Object3D();

  const burst = () => {
    if (CALM) return;
    for (let i = 0; i < CONFETTI * 0.6; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      cPos.set([side * 3.4, 0.2, 2.2 + random() * 0.6], i * 3);
      cVel.set([-side * (1.2 + random() * 2.6), 6.5 + random() * 4.5, (random() - 0.5) * 2.4], i * 3);
    }
  };

  // ---------- 蛋糕周围一闪一闪的小星光 ----------
  const sparkleTex = keep(glow("rgba(255,255,240,1)", "rgba(255,214,140,0.8)"));
  const sparkles: THREE.Sprite[] = [];
  for (let i = 0; i < 40; i += 1) {
    const sprite = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: sparkleTex, color: new THREE.Color(1.8, 1.6, 1.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
    const angle = random() * Math.PI * 2;
    const radius = 2 + random() * 2.2;
    sprite.position.set(Math.cos(angle) * radius, 0.4 + random() * 4.6, Math.sin(angle) * radius * 0.6 - 0.5);
    sprite.userData = { phase: random() * Math.PI * 2, speed: 1.5 + random() * 2.5, size: 0.08 + random() * 0.12 };
    sparkles.push(sprite);
    scene.add(sprite);
  }

  // ---------- 几只从下往上飘走的气球（循环） ----------
  const risers = Array.from({ length: 4 }, (_, i) => {
    const material = keep(new THREE.MeshPhysicalMaterial({ color: PARTY[(i + 2) % PARTY.length], roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12 }));
    const group = new THREE.Group();
    group.add(new THREE.Mesh(balloonGeo, material));
    const knot = new THREE.Mesh(knotGeo, material);
    knot.position.y = -0.64;
    group.add(knot);
    group.scale.setScalar(0.55 + random() * 0.25);
    scene.add(group);
    return { group, x: (i % 2 === 0 ? -1 : 1) * (1.3 + random() * 1.6), z: -2.5 - random() * 2, speed: 0.35 + random() * 0.25, offset: random() * 12 };
  });

  // ---------- 蛋糕跟着鼠标（手机上跟着手指）左右转 ----------
  let pointerX = 0;
  let pointerSeen = false;
  const pointerNdc = new THREE.Vector2(9, 9);
  const onPointer = (event: PointerEvent) => {
    pointerX = (event.clientX / window.innerWidth) * 2 - 1;
    pointerNdc.set(pointerX, -(event.clientY / window.innerHeight) * 2 + 1);
    pointerSeen = true;
  };
  // 鼠标在某个深度平面上的世界坐标（气球、彩旗各在自己的深度）
  const ray = new THREE.Raycaster();
  const pointerAt = (z: number, out: THREE.Vector3) => {
    const { origin, direction } = ray.ray;
    return out.copy(origin).addScaledVector(direction, (z - origin.z) / direction.z);
  };
  const hit = new THREE.Vector3();
  const lastFlagHit = new THREE.Vector3();
  const push = new THREE.Vector2();
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onPointer, { passive: true });

  // ---------- 后期：烛火、串灯的光晕 ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.5, 1.25); // 阈值高于奶油高光：只有烛火、串灯发光
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------- 镜头 ----------
  const hero = { pos: new THREE.Vector3(), look: new THREE.Vector3(0, 2.2, 0) };
  const up = { pos: new THREE.Vector3(), look: new THREE.Vector3(0, 5.2, -2) };
  const close = { pos: new THREE.Vector3(), look: new THREE.Vector3(0, 4.1, 0) };
  let spread = 2.6;
  const resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    bloom.resolution.set(width / 2, height / 2);
    camera.aspect = width / height;
    const portrait = camera.aspect < 0.8;
    camera.fov = portrait ? 54 : 38;
    camera.updateProjectionMatrix();
    hero.pos.set(0, portrait ? 3.4 : 3.6, portrait ? 10.2 : 11.4);
    up.pos.set(0, portrait ? 5.6 : 5.6, portrait ? 9.6 : 10.6);
    // 结尾：从蛋糕略下方仰看，烛光落在画面下三分之一，寄语在上方
    close.pos.set(0.5, 2.9, portrait ? 6.4 : 5.2);
    // 竖屏时气球往中间收，免得全在画面外
    spread = THREE.MathUtils.clamp(camera.aspect * 3.6, 1.9, 3.2);
  };
  resize();
  window.addEventListener("resize", resize);

  const introStart = { pos: new THREE.Vector3(0, 11, 17), look: new THREE.Vector3(0, 3, 0) };
  let introAt = CALM ? -Infinity : Number.POSITIVE_INFINITY;
  let burstAt = Number.POSITIVE_INFINITY;
  let progress = 0;
  let cakeTurn = 0;
  const lookAt = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();
  let last = performance.now() / 1000;

  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, now - last);
    last = now;
    const t = now * AMBIENT;

    // 滚动进度（rAF 里读，不挂 scroll 监听），带一点惯性
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const target = max > 0 ? window.scrollY / max : 0;
    progress += (target - progress) * (CALM ? 1 : Math.min(1, dt * 4));

    // 顶部看蛋糕 → 读祝福时上移 → 结尾推近烛光
    const toUp = smooth(clamp01((progress - 0.04) / 0.22));
    const toClose = smooth(clamp01((progress - 0.82) / 0.18));
    tmpPos.lerpVectors(hero.pos, up.pos, toUp).lerp(close.pos, toClose);
    tmpLook.lerpVectors(hero.look, up.look, toUp).lerp(close.look, toClose);
    tmpPos.x += Math.sin(t * 0.18) * 0.6 * (1 - toClose);
    const intro = now < introAt ? 0 : easeOutCubic(clamp01((now - introAt) / 2.6));
    camera.position.lerpVectors(introStart.pos, tmpPos, intro);
    lookAt.lerpVectors(introStart.look, tmpLook, intro);
    camera.lookAt(lookAt);
    if (now > burstAt) {
      burstAt = Number.POSITIVE_INFINITY;
      burst();
    }

    // 蛋糕：有鼠标/手指时转向那一侧（最多约 45°），没有时自己慢慢左右摆
    const turnTarget = pointerSeen ? pointerX * 0.8 : Math.sin(t * 0.35) * 0.45;
    cakeTurn += (turnTarget - cakeTurn) * Math.min(1, dt * 3);
    cake.rotation.y = cakeTurn;
    cake.position.y = Math.sin(t * 1.1) * 0.03;

    ray.setFromCamera(pointerNdc, camera);
    // 气球：靠近鼠标会被轻轻推开，再弹回来；整体随鼠标有一点视差
    for (const b of balloons) {
      const x = b.side * (spread + b.offset) + Math.sin(t * 0.5 + b.phase) * 0.12 + pointerX * 0.18 * (1 + b.z * -0.15);
      const y = b.y + Math.sin(t * 1.2 + b.phase) * 0.22;
      pointerAt(b.z, hit);
      push.set(x + b.off.x - hit.x, y + b.off.y - hit.y);
      const reach = b.radius + 0.55;
      const dist = push.length();
      const force = pointerSeen && dist < reach ? push.normalize().multiplyScalar((reach - dist) * 26) : push.set(0, 0);
      b.vel.x += (force.x - b.off.x * 9 - b.vel.x * 3.2) * dt;
      b.vel.y += (force.y - b.off.y * 9 - b.vel.y * 3.2) * dt;
      b.off.addScaledVector(b.vel, dt);
      b.group.position.set(x + b.off.x, y + b.off.y, b.z);
      b.group.rotation.z = Math.sin(t * 0.9 + b.phase) * 0.12 - b.off.x * 0.35;
    }
    for (const r of risers) {
      const y = -1.5 + ((t * r.speed + r.offset) % 13);
      r.group.position.set(r.x * (spread / 3.2) + Math.sin(t * 0.8 + r.offset) * 0.3, y, r.z);
      r.group.rotation.z = Math.sin(t * 1.1 + r.offset) * 0.15;
    }
    flames.forEach((f, i) => {
      const k = 1 + Math.sin(t * 15 + i * 1.7) * 0.1 + Math.sin(t * 8.3 + i) * 0.08;
      f.scale.set(0.2 * k, 0.32 * (2 - k), 1);
      f.position.x = f.userData.x + Math.sin(t * 6 + i) * 0.008;
    });
    candleLight.intensity = 3 + Math.sin(t * 11) * 0.45;
    // 彩旗：鼠标划过时被拨动，荡几下再停
    const flagZ = flags[0].position.z;
    pointerAt(flagZ, hit);
    const sweep = pointerSeen ? (hit.x - lastFlagHit.x) / Math.max(dt, 1e-3) : 0;
    lastFlagHit.copy(hit);
    for (const flag of flags) {
      const d = flag.userData;
      const dx = flag.position.x - hit.x;
      const dy = flag.position.y - 0.2 - hit.y;
      const near = Math.max(0, 1 - Math.hypot(dx, dy) / 1.3);
      d.swingVel += (near * THREE.MathUtils.clamp(sweep, -12, 12) * 0.9 - d.swing * 14 - d.swingVel * 2.2) * dt;
      d.swing += d.swingVel * dt;
      flag.rotation.x = Math.sin(t * 2.2 + d.phase) * 0.38 + d.swing * 0.6;
      flag.rotation.z = Math.sin(t * 1.3 + d.phase) * 0.08 + d.swing;
    }
    // 串灯：一圈亮光沿着灯串跑
    bulbs.forEach((bulb, i) => {
      const chase = 0.5 + 0.5 * Math.sin(t * 3 - i * 0.55);
      (bulb.material as THREE.MeshBasicMaterial).color.setHex(0xffd28a).multiplyScalar(1.2 + 2.6 * chase * chase);
    });
    for (const sp of sparkles) {
      const pulse = Math.max(0, Math.sin(t * sp.userData.speed + sp.userData.phase));
      sp.scale.setScalar(sp.userData.size * (0.2 + pulse * 1.4));
      (sp.material as THREE.SpriteMaterial).opacity = pulse;
    }

    for (let i = 0; i < CONFETTI; i += 1) {
      const o = i * 3;
      const step = dt * AMBIENT;
      cVel[o + 1] = Math.max(cVel[o + 1] - 7.5 * step, -(0.45 + (i % 5) * 0.08));
      cVel[o] *= 1 - step * 0.9;
      cVel[o + 2] *= 1 - step * 0.9;
      cPos[o] += (cVel[o] + Math.sin(t * 1.3 + i) * 0.18) * step;
      cPos[o + 1] += cVel[o + 1] * step;
      cPos[o + 2] += cVel[o + 2] * step;
      cRot[o] += cSpin[o] * step;
      cRot[o + 1] += cSpin[o + 1] * step;
      cRot[o + 2] += cSpin[o + 2] * step;
      if (cPos[o + 1] < -0.5) respawn(i, false);
      dummy.position.set(cPos[o], cPos[o + 1], cPos[o + 2]);
      dummy.rotation.set(cRot[o], cRot[o + 1], cRot[o + 2]);
      dummy.updateMatrix();
      confetti.setMatrixAt(i, dummy.matrix);
    }
    confetti.instanceMatrix.needsUpdate = true;

    composer.render();
  };
  frame();

  return {
    intro() {
      if (CALM) return;
      introAt = performance.now() / 1000;
      burstAt = introAt + 1.1;
    },
    burst,
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      for (const item of disposables) item.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
}
