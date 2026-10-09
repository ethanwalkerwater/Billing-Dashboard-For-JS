/** 生日网页：取数 → 信封 → 吹蜡烛 → 星座 → 卡片墙 → 寄语。所有文字都用 textContent 写入。 */
import type { PageData } from "../domain/page-data";
import { listenForBlow } from "./blow";
import { renderCards } from "./cards";
import { demoData } from "./demo";
import type { SceneHandle } from "./scene";
import "./styles.css";

// three.js 块和取数并行下载，拆信时通常已经到了
const scenePromise = import("./scene");
scenePromise.catch(() => {}); // 失败时在 startStage 里降级，这里只防未处理拒绝

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  $("stage-title").textContent = title;
  const n = data.wishes.length;
  $("sky-line").textContent = n > 0 ? `${n} 颗星星，是 ${n} 份想对你说的话` : "祝福还在路上，星星先替大家亮着";
  $("sky-sub").textContent = n > 0 ? "点一颗星星，看看是谁写的" : "";
  $("to-wall").textContent = n > 0 ? "读祝福" : "往下看";

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
function reveal(targets: Element[]) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("seen");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.2 },
  );
  for (const target of targets) observer.observe(target);
}

async function startStage(data: PageData) {
  const stage = $("stage");
  stage.hidden = false;
  const candles = data.tenure?.candles ?? 1;
  const cards = renderCards($("cards"), data.wishes);
  cards.forEach((card, i) => card.style.setProperty("--k", String(i % 6)));

  // WebGL 不可用时降级成 CSS 蛋糕，后面流程不变
  let scene: SceneHandle | null = null;
  try {
    const { createScene } = await scenePromise;
    scene = createScene($<HTMLCanvasElement>("scene"), {
      candles,
      stars: data.wishes.length,
      name: data.name,
      onStar: (index) => {
        const card = cards[index];
        if (!card) return;
        $("wall").scrollIntoView({ behavior: "smooth" });
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => card.classList.add("flipped"), 600);
      },
    });
  } catch (error) {
    console.warn("WebGL 不可用，改用静态蛋糕", error);
    document.body.classList.add("no-webgl");
    $("css-candles").replaceChildren(...Array.from({ length: candles }, () => document.createElement("i")));
  }
  window.addEventListener("pagehide", () => scene?.dispose(), { once: true });

  requestAnimationFrame(() => stage.classList.add("ready"));
  listenForBlow(stage, async () => {
    stage.classList.add("blown");
    if (scene) await scene.extinguish();
    else await wait(1200);
    $("sky-caption").hidden = false;
    requestAnimationFrame(() => stage.classList.add("sky"));
    document.body.classList.remove("locked");
    if (data.wishes.length > 0) {
      $("wall").hidden = false;
      reveal(cards);
    }
    $("finale").hidden = false;
    reveal([$("finale")]);
  });
}

async function main() {
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
  $("loading").hidden = true;
  const letter = $("letter");
  letter.hidden = false;
  $("tap-hint").hidden = false;
  letter.addEventListener(
    "click",
    async () => {
      $("envelope").classList.add("opening");
      $("tap-hint").hidden = true;
      await startStage(data);
      await wait(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1100);
      $("envelope").hidden = true;
    },
    { once: true },
  );
}

void main();
