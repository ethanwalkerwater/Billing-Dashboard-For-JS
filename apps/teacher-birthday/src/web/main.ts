/**
 * 生日网页：取数 → 信封 → 派对场景（镜头俯冲 + 彩纸礼炮）→ 卡片墙 → 寄语（再一次礼炮）。
 * 3D 场景铺满整页背景，镜头随滚动连续移动，各段内容浮在场景上，不做硬切换。所有文字都用 textContent 写入。
 */
import type { PageData } from "../domain/page-data";
import { renderCards } from "./cards";
import { demoData } from "./demo";
import type { SceneHandle } from "./scene";
import "./styles.css";

// three.js 块和取数并行下载，拆信时通常已经到了
const scenePromise = import("./scene");
scenePromise.catch(() => {}); // 失败时在 startStage 里降级，这里只防未处理拒绝

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function load(): Promise<PageData> {
  const params = new URLSearchParams(location.search);
  const token = params.get("t");
  if (!token) return demoData(Number(params.get("demo") ?? 6));
  const response = await fetch(`/birthday-api/page?t=${encodeURIComponent(token)}`);
  if (response.status === 403) throw new Error("INVALID_LINK");
  if (!response.ok) throw new Error("NETWORK");
  return ((await response.json()) as { data: PageData }).data;
}

function showProblem(kind: string) {
  $("loading").hidden = true;
  $("problem").hidden = false;
  $("problem-text").textContent = kind === "INVALID_LINK" ? "这个链接打不开了，请联系教务老师重新发送。" : "网络有点慢，礼物还没送到。";
  $("retry").hidden = kind === "INVALID_LINK";
}

function fillText(data: PageData) {
  const title = `${data.name}老师，生日快乐`;
  document.title = title;
  $("letter-to").textContent = `致 ${data.name} 老师`;
  // 标题两行，逐字弹出
  let index = 0;
  $("hero-title").replaceChildren(
    ...[`${data.name}老师`, "生日快乐"].map((line) => {
      const row = document.createElement("span");
      row.className = "line";
      for (const ch of line) {
        const span = document.createElement("span");
        span.className = "ch";
        span.textContent = ch;
        span.style.setProperty("--i", String(index++));
        row.append(span);
      }
      return row;
    }),
  );
  const n = data.wishes.length;
  $("hero-sub").textContent = n > 0 ? `${n} 位同学和同事给你写了祝福` : "大家的祝福正在路上";
  $("to-wall").textContent = n > 0 ? "看看大家说了什么" : "往下看";

  if (data.photoUrl) {
    $<HTMLImageElement>("portrait-img").src = data.photoUrl;
    $("portrait").hidden = false;
  }
  if (data.tenure) {
    $("tenure").textContent = `今天是你在菁仕的第 ${data.tenure.days} 天`;
    $("tenure").hidden = false;
  }
  if (data.stats && data.stats.lessons > 0) {
    $("stats").textContent = `这一年，你上了 ${data.stats.lessons} 节课，陪 ${data.stats.students} 位同学走过 ${data.stats.hours} 个小时。`;
    $("stats").hidden = false;
  }
  const blessing = $("blessing");
  blessing.replaceChildren(
    ...(data.blessing.match(/[^。！？!?]+[。！？!?]*/g) ?? [data.blessing]).map((sentence, i) => {
      const span = document.createElement("span");
      span.textContent = sentence;
      span.style.setProperty("--i", String(i));
      return span;
    }),
  );
  $("signature").textContent = `菁仕教育全体 · ${data.year}`;
}

/** 元素进入视口时加 .seen 触发入场动画。卡片逐张观察：整面墙很高时按整段算比例永远到不了阈值。 */
function reveal(targets: Element[], onSeen?: () => void) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("seen");
          observer.unobserve(entry.target);
          onSeen?.();
        }
      }
    },
    { threshold: 0.2 },
  );
  for (const target of targets) observer.observe(target);
}

/** 数据一到就把场景建在信封后面（镜头停在高处），拆信时着色器已经编译好，过渡不卡。 */
async function prepareScene(data: PageData): Promise<SceneHandle | null> {
  const candles = data.tenure?.candles ?? 1;
  try {
    const { createScene } = await scenePromise;
    const scene = createScene($<HTMLCanvasElement>("scene"), { candles, name: data.name });
    window.addEventListener("pagehide", () => scene.dispose(), { once: true });
    return scene;
  } catch (error) {
    console.warn("WebGL 不可用，改用静态蛋糕", error);
    document.body.classList.add("no-webgl");
    $("css-candles").replaceChildren(...Array.from({ length: candles }, () => document.createElement("i")));
    return null;
  }
}

function openParty(data: PageData, scene: SceneHandle | null) {
  scene?.intro();
  document.body.classList.add("party");
  const hero = $("hero");
  hero.hidden = false;
  // 镜头俯冲快落定时，标题逐字弹出
  setTimeout(() => hero.classList.add("play"), REDUCED ? 0 : 900);
  document.body.classList.remove("locked");

  const cards = renderCards($("cards"), data.wishes);
  cards.forEach((card, i) => card.style.setProperty("--k", String(i % 3)));
  if (cards.length > 0) {
    $("wall").hidden = false;
    reveal(cards);
  }
  $("finale").hidden = false;
  // 读到寄语时再放一次礼炮
  reveal([$("finale")], () => scene?.burst());
}

async function main() {
  // 每次打开都从信封开始，不恢复上次的滚动位置
  history.scrollRestoration = "manual";
  window.scrollTo(0, 0);
  $("retry").addEventListener("click", () => location.reload());
  $("to-wall").addEventListener("click", () => ($("wall").hidden ? $("finale") : $("wall")).scrollIntoView({ behavior: "smooth" }));
  let data: PageData;
  try {
    data = await load();
  } catch (error) {
    showProblem((error as Error).message);
    return;
  }
  fillText(data);
  const scene = await prepareScene(data);
  $("loading").hidden = true;
  const letter = $("letter");
  letter.hidden = false;
  $("tap-hint").hidden = false;
  letter.addEventListener(
    "click",
    async () => {
      $("envelope").classList.add("opening");
      $("tap-hint").hidden = true;
      openParty(data, scene);
      await wait(REDUCED ? 0 : 1300);
      $("envelope").hidden = true;
    },
    { once: true },
  );
}

void main();
