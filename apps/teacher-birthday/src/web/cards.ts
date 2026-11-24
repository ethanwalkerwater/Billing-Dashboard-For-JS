import type { PageData } from "../domain/page-data";

const HOVER = window.matchMedia("(hover: hover) and (pointer: fine)");
const ROLE_LABEL: Record<string, string> = { 学生: "来自学生", 家长: "来自家长", 同事: "来自同事" };

/** 拍立得卡片：正面是图片（没图用大号首字），点击翻面读留言。轻微随机倾斜，按名字做种子保持稳定。 */
export function renderCards(root: HTMLElement, wishes: PageData["wishes"]): HTMLElement[] {
  root.replaceChildren();
  return wishes.map((wish, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "polaroid";
    card.style.setProperty("--tilt", `${(([...wish.name].reduce((s, c) => s + c.codePointAt(0)!, index) % 7) - 3) * 0.8}deg`);
    card.setAttribute("aria-label", `${wish.name}的祝福`);

    const front = document.createElement("div");
    front.className = "face front";
    const media = wish.media[0];
    if (media?.kind === "image") {
      const img = document.createElement("img");
      img.src = media.url;
      img.alt = "";
      img.loading = "lazy";
      front.append(img);
    } else if (media?.kind === "video") {
      const video = document.createElement("video");
      video.src = media.url;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      front.append(video);
    } else {
      const initial = document.createElement("span");
      initial.className = "initial";
      initial.textContent = [...wish.name][0] ?? "♡";
      front.append(initial);
    }
    const caption = document.createElement("p");
    caption.className = "caption";
    caption.textContent = `${wish.name} · ${ROLE_LABEL[wish.role] ?? "来自朋友"}`;
    front.append(caption);

    const back = document.createElement("div");
    back.className = "face back";
    const text = document.createElement("p");
    text.textContent = wish.text;
    const sign = document.createElement("p");
    sign.className = "sign";
    sign.textContent = wish.name;
    back.append(text, sign);

    card.append(front, back);
    // 有鼠标的设备悬停即翻面（CSS :hover）；触屏没有悬停，点一下翻面
    card.addEventListener("click", () => {
      if (!HOVER.matches) card.classList.toggle("flipped");
    });
    root.append(card);
    return card;
  });
}
