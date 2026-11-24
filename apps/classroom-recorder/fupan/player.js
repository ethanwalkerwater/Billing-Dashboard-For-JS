import { esc, timestamp } from "./ui.js";

const drawer = document.getElementById("player");
let generation = 0;
let audio = null;
let lines = [];
let currentIndex = -1;

export function stopPlayer() {
  generation++;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  audio = null;
  lines = [];
  currentIndex = -1;
  drawer.replaceChildren();
  if (drawer.open) drawer.close();
}
drawer.addEventListener("close", () => {
  if (!drawer.open) stopPlayer();
});

export async function openPlayer(
  api,
  lessonId,
  at = 0,
  play = false,
  existingLesson = null,
  issues = [],
) {
  stopPlayer();
  const request = ++generation;
  drawer.innerHTML =
    '<div class="row pad"><h2 id="player-title" class="grow">逐字稿与回听</h2><button class="btn sm outline" data-dismiss autofocus>关闭</button></div><p class="pad" role="status">正在读取课程…</p>';
  drawer.querySelector("[data-dismiss]").onclick = stopPlayer;
  drawer.showModal();
  try {
    const lesson =
      existingLesson?.id === lessonId
        ? existingLesson
        : await api("/lesson", { id: lessonId });
    if (request !== generation) return;
    lines = lesson.transcript || [];
    const markers = new Map();
    for (const issue of issues) {
      for (const evidence of issue.evidence || [])
        markers.set(evidence.line, issue);
    }
    drawer.lastElementChild.remove();
    drawer.insertAdjacentHTML(
      "beforeend",
      `<div class="pad"><strong>${esc(lesson.course)}</strong><span class="muted"> · ${esc(lesson.teacherName)}</span>
      <div class="row wrap spaced">
      ${lesson.hasAudio ? '<button class="btn sm" data-start>播放原音</button><button class="btn sm outline" data-skip="-15" aria-label="后退15秒">−15 秒</button><button class="btn sm outline" data-skip="15" aria-label="前进15秒">+15 秒</button><label>倍速 <select data-rate><option>0.75</option><option selected>1</option><option>1.25</option><option>1.5</option><option>2</option></select></label>' : '<span class="badge sec">' + esc(lesson.recording === "原音已过期" ? lesson.recording : "暂无可播放原音") + "</span>"}
      </div><audio controls preload="none" hidden></audio><p role="status" class="sm muted" data-status></p></div>
      <div class="transcript">${lines.length ? lines.map((x, i) => '<button type="button" class="ln" data-line="' + i + '"><time>' + timestamp(x.start) + "</time><small>" + esc(x.speaker) + "</small><span>" + esc(x.text) + (markers.has(i) ? ' <small class="badge sec">' + esc(markers.get(i).category) + "</small>" : "") + "</span></button>").join("") : '<p class="pad preserve">' + esc(lesson.transcriptText || "暂无逐字稿。") + "</p>"}</div>`,
    );
    audio = drawer.querySelector("audio");
    const player = audio,
      status = drawer.querySelector("[data-status]"),
      startButton = drawer.querySelector("[data-start]");
    const lineEls = drawer.querySelectorAll("[data-line]");
    let target = Math.max(0, Number(at) || 0),
      loading = false;
    const update = (time, force = false) => {
      // Seek may move back to an earlier line. One indexed scan works even with overlapping speaker turns.
      const index = lines.findLastIndex((row) => row.start <= time);
      if (index === currentIndex && !force) return;
      lineEls[currentIndex]?.removeAttribute("aria-current");
      currentIndex = index;
      const el = lineEls[index];
      if (el) {
        el.setAttribute("aria-current", "true");
        el.scrollIntoView({ block: "nearest" });
      }
    };
    const seek = (time) => {
      target = Math.max(0, time);
      if (player.readyState >= 1)
        player.currentTime = Number.isFinite(player.duration)
          ? Math.min(player.duration, target)
          : target;
      update(target, true);
    };
    const start = async (time) => {
      seek(time);
      if (!lesson.hasAudio || loading) return;
      try {
        if (!player.getAttribute("src")) {
          loading = true;
          status.textContent = "正在获取原音…";
          const { url } = await api("/audio", { id: lessonId });
          if (request !== generation) return;
          const secured = new URL(url);
          if (secured.protocol !== "https:") throw Error("录音地址无效。");
          player.addEventListener("loadedmetadata", () => seek(target), {
            once: true,
          });
          player.src = secured.href;
          player.hidden = false;
        }
        await player.play();
        if (request !== generation) return;
        status.textContent = "";
        if (startButton) startButton.hidden = true;
      } catch (err) {
        if (request !== generation) return;
        status.textContent =
          err.name === "NotAllowedError"
            ? "请点击播放开始回听。"
            : err.message || "无法播放原音。";
        if (startButton) startButton.hidden = false;
      } finally {
        loading = false;
      }
    };
    player.addEventListener("timeupdate", () => {
      if (request === generation && !player.seeking) update(player.currentTime);
    });
    player.addEventListener("error", () => {
      if (request !== generation) return;
      target = player.currentTime || target;
      player.removeAttribute("src");
      player.load();
      player.hidden = true;
      if (startButton) {
        startButton.hidden = false;
        startButton.textContent = "重新获取原音";
      }
      status.textContent = "原音暂不可播放，可以重新获取。";
    });
    if (startButton) startButton.onclick = () => start(target);
    drawer.querySelector("[data-rate]")?.addEventListener("change", (e) => {
      player.playbackRate = Number(e.target.value);
    });
    drawer
      .querySelectorAll("[data-skip]")
      .forEach(
        (el) =>
          (el.onclick = () =>
            seek(
              (player.getAttribute("src") ? player.currentTime : target) +
                Number(el.dataset.skip),
            )),
      );
    drawer.querySelector(".transcript").onclick = (e) => {
      const index = e.target.closest("[data-line]")?.dataset.line;
      if (index !== undefined) start(lines[Number(index)].start);
    };
    update(target, true);
    if (play && lesson.hasAudio) await start(target);
  } catch (err) {
    if (request === generation)
      drawer.lastElementChild.textContent = err.message || "课程读取失败。";
  }
}
