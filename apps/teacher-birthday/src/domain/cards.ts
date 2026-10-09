import type { Ymd } from "./dates";
import { WISH_FIELDS } from "./records";

export type FeishuCard = Record<string, unknown>;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const mmdd = ({ y, m, d }: Ymd) => `${m}/${d}（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;

export function wishFormUrl(base: string, teacherName: string, year: number): string {
  const url = new URL(base);
  url.searchParams.set(`prefill_${WISH_FIELDS.teacher}`, teacherName);
  url.searchParams.set(`hide_${WISH_FIELDS.teacher}`, "1");
  url.searchParams.set(`prefill_${WISH_FIELDS.year}`, String(year));
  url.searchParams.set(`hide_${WISH_FIELDS.year}`, "1");
  return url.href;
}

const button = (text: string, url: string, type = "primary") => ({
  tag: "action",
  actions: [{ tag: "button", text: { tag: "plain_text", content: text }, type, url }],
});

export function askCard(input: { teacherName: string; date: Ymd; daysLeft: number; formUrl: string; wishCount: number }): FeishuCard {
  const when = input.daysLeft === 0 ? "就是今天" : `还有 ${input.daysLeft} 天`;
  return {
    config: { wide_screen_mode: true },
    header: { template: "orange", title: { tag: "plain_text", content: `🎂 ${input.teacherName} 老师 ${mmdd(input.date)} 生日` } },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `距离生日${when}。请把下面的祝福问卷转给 **${input.teacherName}** 老师的学生、家长和同事，大家写下想说的话，也可以传图片和表情包。`,
            `生日当天 9:00，祝福会做成一个专属网页发到老师群。${input.wishCount > 0 ? `\n目前已收到 **${input.wishCount}** 条祝福。` : ""}`,
            `问卷链接（可直接复制转发）：\n${input.formUrl}`,
          ].join("\n\n"),
        },
      },
      button("打开祝福问卷", input.formUrl),
    ],
  };
}

export function celebrateCard(input: { teacherName: string; openId: string | null; pageUrl: string; wishCount: number }): FeishuCard {
  const who = input.openId ? `<at id=${input.openId}></at>` : `**${input.teacherName}** 老师`;
  const gift = input.wishCount > 0 ? `同学和同事们写了 **${input.wishCount}** 条祝福，装进了一份小礼物里。` : "我们给你准备了一份小礼物。";
  return {
    config: { wide_screen_mode: true },
    header: { template: "carmine", title: { tag: "plain_text", content: `🎂 今天是 ${input.teacherName} 老师的生日` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `${who} 生日快乐！\n${gift}点开它，记得对着蛋糕吹一口气。` } },
      button("打开生日礼物 🎁", input.pageUrl),
    ],
  };
}
