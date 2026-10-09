/**
 * 生日 3D 场景：蛋糕和蜡烛 → 吹灭 → 烟化成星星升空，连成以老师名字命名的星座。
 * 星星位置由名字做种子，同一位老师每次打开都一样。WebGLRenderer 创建失败时直接抛出，由调用方降级。
 */
import * as THREE from "three";

export interface SceneHandle {
  extinguish(): Promise<void>;
  dispose(): void;
}

interface SceneOptions {
  candles: number;
  stars: number;
  name: string;
  onStar(index: number): void;
}

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const CAKE_TOP = 1.55;
const MIN_STARS = 7;

function seeded(name: string) {
  let seed = [...name].reduce((sum, ch) => (sum * 31 + ch.codePointAt(0)!) >>> 0, 7);
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function glowTexture(inner: string, outer: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.25, outer);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export function createScene(canvas: HTMLCanvasElement, opts: SceneOptions): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  const cakeView = { pos: new THREE.Vector3(0, 2.7, 6.6), look: new THREE.Vector3(0, 1.25, 0) };
  const skyView = { pos: new THREE.Vector3(0, 3.6, 8.2), look: new THREE.Vector3(0, 9.6, -5) };
  camera.position.copy(cakeView.pos);
  camera.lookAt(cakeView.look);

  // 灯光：冷色夜空 + 一盏随烛火闪烁的暖光
  const hemi = new THREE.HemisphereLight(0xc4bcf2, 0x3a2f5c, 1.5);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xfff1e6, 0.55);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xc9c2ff, 0.5);
  key.position.set(-3, 6, 4);
  scene.add(key);
  const candleLight = new THREE.PointLight(0xffb15c, 4, 9, 1);
  candleLight.position.set(0, CAKE_TOP + 0.9, 0.4);
  scene.add(candleLight);

  // 蛋糕
  const disposables: Array<{ dispose(): void }> = [];
  const mesh = (geometry: THREE.BufferGeometry, color: number, roughness = 0.65) => {
    const material = new THREE.MeshStandardMaterial({ color, roughness });
    disposables.push(geometry, material);
    return new THREE.Mesh(geometry, material);
  };
  const cake = new THREE.Group();
  const plate = mesh(new THREE.CylinderGeometry(2.05, 2.1, 0.08, 64), 0xd9d6e4, 0.35);
  plate.position.y = 0.04;
  const bottom = mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.85, 64), 0xe7c6c4);
  bottom.position.y = 0.08 + 0.425;
  const top = mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.62, 64), 0xf3e4dc);
  top.position.y = 0.93 + 0.31;
  cake.add(plate, bottom, top);
  const bead = new THREE.SphereGeometry(0.075, 12, 12);
  const beadMaterial = new THREE.MeshStandardMaterial({ color: 0xfff7f2, roughness: 0.4 });
  disposables.push(bead, beadMaterial);
  for (const [radius, y, count] of [[1.6, 0.93, 42], [1.1, CAKE_TOP, 30]] as const) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const b = new THREE.Mesh(bead, beadMaterial);
      b.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      cake.add(b);
    }
  }
  scene.add(cake);

  // 蜡烛与火焰
  const flameTexture = glowTexture("rgba(255,244,214,1)", "rgba(255,170,70,0.85)");
  const flames: THREE.Sprite[] = [];
  const candleTops: THREE.Vector3[] = [];
  const candleGeometry = new THREE.CylinderGeometry(0.055, 0.055, 0.55, 16);
  disposables.push(candleGeometry, flameTexture);
  const candleColors = [0xf2b8c6, 0xb9d3ef, 0xf6dfa4];
  const ring = opts.candles === 1 ? 0 : Math.min(0.75, 0.25 + opts.candles * 0.06);
  for (let i = 0; i < opts.candles; i += 1) {
    const angle = (i / opts.candles) * Math.PI * 2;
    const material = new THREE.MeshStandardMaterial({ color: candleColors[i % candleColors.length], roughness: 0.5 });
    disposables.push(material);
    const candle = new THREE.Mesh(candleGeometry, material);
    candle.position.set(Math.cos(angle) * ring, CAKE_TOP + 0.275, Math.sin(angle) * ring);
    cake.add(candle);
    const flameMaterial = new THREE.SpriteMaterial({ map: flameTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    disposables.push(flameMaterial);
    const flame = new THREE.Sprite(flameMaterial);
    flame.position.set(candle.position.x, CAKE_TOP + 0.66, candle.position.z);
    flame.scale.set(0.32, 0.5, 1);
    flames.push(flame);
    candleTops.push(flame.position.clone());
    cake.add(flame);
  }

  // 远处的星空背景
  const random = seeded(opts.name);
  const far = new THREE.BufferGeometry();
  const farPositions = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i += 1) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(random() * 1.6 - 0.6);
    farPositions.set([Math.sin(phi) * Math.cos(theta) * 40, Math.cos(phi) * 40 + 4, Math.sin(phi) * Math.sin(theta) * 40 - 10], i * 3);
  }
  far.setAttribute("position", new THREE.BufferAttribute(farPositions, 3));
  const farMaterial = new THREE.PointsMaterial({ color: 0xcfc8ff, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false });
  disposables.push(far, farMaterial);
  scene.add(new THREE.Points(far, farMaterial));

  // 祝福星星（前 opts.stars 颗可点），位置按老师名字固定
  const starTexture = glowTexture("rgba(255,250,235,1)", "rgba(255,200,110,0.7)");
  disposables.push(starTexture);
  const starCount = Math.max(opts.stars, MIN_STARS);
  const halfWidth = () => Math.min(5.5, Math.max(2, camera.aspect * 5.2));
  const starSeeds = Array.from({ length: starCount }, () => [random(), random(), random()]);
  const stars: THREE.Sprite[] = starSeeds.map(([sx, sy], i) => {
    const material = new THREE.SpriteMaterial({ map: starTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
    disposables.push(material);
    const sprite = new THREE.Sprite(material);
    sprite.userData = { index: i, wish: i < opts.stars, base: i < opts.stars ? 0.62 : 0.34, sx, sy };
    scene.add(sprite);
    return sprite;
  });
  const placeStars = () => {
    const w = halfWidth();
    stars.forEach((star, i) => {
      const [, , sz] = starSeeds[i];
      star.position.set((star.userData.sx * 2 - 1) * w, 8 + star.userData.sy * 4.2, -5 - sz * 2);
      star.scale.setScalar(star.userData.base);
    });
    const ordered = [...stars].sort((a, b) => a.position.x - b.position.x);
    lineGeometry.setFromPoints(ordered.map((star) => star.position));
  };
  const lineGeometry = new THREE.BufferGeometry();
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffd8a0, transparent: true, opacity: 0.35 });
  disposables.push(lineGeometry, lineMaterial);
  const constellation = new THREE.Line(lineGeometry, lineMaterial);
  scene.add(constellation);

  // 烟 → 星的粒子
  const perCandle = 40;
  const smokeCount = perCandle * opts.candles;
  const smokeGeometry = new THREE.BufferGeometry();
  const smokePositions = new Float32Array(smokeCount * 3);
  const smokeStart = new Float32Array(smokeCount * 3);
  const smokeDrift = new Float32Array(smokeCount * 3);
  smokeGeometry.setAttribute("position", new THREE.BufferAttribute(smokePositions, 3));
  const smokeMaterial = new THREE.PointsMaterial({ map: starTexture, color: 0xb8b2c8, size: 0.16, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  disposables.push(smokeGeometry, smokeMaterial);
  const smoke = new THREE.Points(smokeGeometry, smokeMaterial);
  scene.add(smoke);

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // 竖屏手机把蛋糕放远一点，保证整只蛋糕在画面里
    const portrait = camera.aspect < 0.8;
    camera.fov = portrait ? 50 : 40;
    cakeView.pos.set(0, portrait ? 4.2 : 3.2, portrait ? 11.5 : 8.6);
    cakeView.look.set(0, portrait ? 1.0 : 1.4, 0);
    camera.updateProjectionMatrix();
    placeStars();
    if (phase === "cake") {
      camera.position.copy(cakeView.pos);
      camera.lookAt(cakeView.look);
    }
  };

  type Phase = "cake" | "blowing" | "sky";
  let phase: Phase = "cake";
  let blowStart = 0;
  let finish: (() => void) | undefined;
  const lookAt = new THREE.Vector3();
  const seconds = () => performance.now() / 1000;
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const setSky = (progress: number) => {
    const t = easeInOut(progress);
    camera.position.lerpVectors(cakeView.pos, skyView.pos, t);
    lookAt.lerpVectors(cakeView.look, skyView.look, t);
    camera.lookAt(lookAt);
  };

  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = seconds();

    if (phase === "cake" && !REDUCED) {
      flames.forEach((flame, i) => {
        const flicker = 1 + Math.sin(now * 13 + i * 1.7) * 0.06 + Math.sin(now * 7.3 + i) * 0.05;
        flame.scale.set(0.32 * flicker, 0.5 * (2 - flicker), 1);
      });
      candleLight.intensity = 4 + Math.sin(now * 11) * 0.35;
    }

    if (phase === "blowing") {
      const t = now - blowStart;
      // 0–0.4s 火焰熄灭
      const out = clamp01(t / 0.4);
      flames.forEach((flame) => flame.scale.setScalar(Math.max(0.0001, (1 - out) * 0.4)));
      candleLight.intensity = 4 * (1 - out);
      hemi.intensity = 1.5 - 0.6 * clamp01(t / 2);
      ambient.intensity = 0.55 - 0.3 * clamp01(t / 2);
      // 烟：0.2s 起上升，1.2s 起飞向星位
      smokeMaterial.opacity = clamp01((t - 0.2) / 0.4) * (1 - clamp01((t - 3.0) / 0.8));
      const toward = easeInOut(clamp01((t - 1.2) / 1.8));
      const gold = new THREE.Color(0xb8b2c8).lerp(new THREE.Color(0xffd27d), toward);
      smokeMaterial.color.copy(gold);
      for (let i = 0; i < smokeCount; i += 1) {
        const rise = Math.max(0, t - 0.2);
        const x = smokeStart[i * 3] + smokeDrift[i * 3] * rise + Math.sin(rise * 3 + i) * 0.05 * rise;
        const y = smokeStart[i * 3 + 1] + rise * (0.7 + smokeDrift[i * 3 + 1]);
        const z = smokeStart[i * 3 + 2] + smokeDrift[i * 3 + 2] * rise;
        const target = stars[i % starCount].position;
        smokePositions[i * 3] = x + (target.x - x) * toward;
        smokePositions[i * 3 + 1] = y + (target.y - y) * toward;
        smokePositions[i * 3 + 2] = z + (target.z - z) * toward;
      }
      smokeGeometry.attributes.position.needsUpdate = true;
      // 0.9s 起镜头上仰，2.5s 到位
      setSky(clamp01((t - 0.9) / 2.5));
      // 星星在烟到达时亮起，连线逐段画出
      const appear = clamp01((t - 2.6) / 0.8);
      stars.forEach((star) => ((star.material as THREE.SpriteMaterial).opacity = appear));
      const segments = stars.length;
      lineGeometry.setDrawRange(0, Math.ceil(segments * clamp01((t - 3.0) / 1.4)));
      if (t > 4.4) {
        phase = "sky";
        smoke.visible = false;
        finish?.();
      }
    }

    if (phase === "sky" && !REDUCED) {
      stars.forEach((star, i) => star.scale.setScalar(star.userData.base * (1 + Math.sin(now * 2.2 + i * 1.3) * 0.12)));
    }
    renderer.render(scene, camera);
  };
  lineGeometry.setDrawRange(0, 0);
  frame();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pick = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(stars.filter((star) => star.userData.wish))[0]?.object;
  };
  const onUp = (event: PointerEvent) => {
    if (phase !== "sky") return;
    const hit = pick(event);
    if (hit) opts.onStar(hit.userData.index as number);
  };
  const onMove = (event: PointerEvent) => {
    if (phase === "sky" && event.pointerType === "mouse") canvas.style.cursor = pick(event) ? "pointer" : "";
  };
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);

  return {
    extinguish() {
      if (phase !== "cake") return Promise.resolve();
      for (let c = 0; c < opts.candles; c += 1) {
        for (let k = 0; k < perCandle; k += 1) {
          const i = c * perCandle + k;
          smokeStart.set([candleTops[c].x, candleTops[c].y, candleTops[c].z], i * 3);
          smokeDrift.set([(random() - 0.5) * 0.5, random() * 0.6, (random() - 0.5) * 0.5], i * 3);
        }
      }
      if (REDUCED) {
        flames.forEach((flame) => (flame.visible = false));
        candleLight.intensity = 0;
        hemi.intensity = 0.9;
        ambient.intensity = 0.25;
        smoke.visible = false;
        setSky(1);
        stars.forEach((star) => ((star.material as THREE.SpriteMaterial).opacity = 1));
        lineGeometry.setDrawRange(0, stars.length);
        phase = "sky";
        return Promise.resolve();
      }
      phase = "blowing";
      blowStart = seconds();
      return new Promise<void>((resolve) => (finish = resolve));
    },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      for (const item of disposables) item.dispose();
      renderer.dispose();
    },
  };
}
