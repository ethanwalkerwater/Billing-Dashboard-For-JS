import type { PageData } from "../domain/page-data";

const SAMPLES = [
  ["小王", "学生", "谢谢老师把电磁学讲得像故事一样，我第一次觉得物理好玩！"],
  ["Gavin 妈妈", "家长", "孩子说汤老师很会教，学物理没那么难了。祝老师生日快乐！"],
  ["李老师", "同事", "隔壁教室总能听到你们的笑声，生日快乐，搭档！"],
  ["袁同学", "学生", "讲课好玩，生日快乐🎂"],
] as const;

export function demoData(count: number): PageData {
  return {
    name: "汤朔",
    subject: "物理",
    photoUrl: "https://picsum.photos/seed/jsjy-teacher-portrait/480/640",
    year: new Date().getFullYear(),
    dateLabel: "10 月 12 日",
    tenure: { days: 732, candles: 2 },
    stats: { lessons: 318, students: 27, hours: 596.5 },
    blessing: "汤朔老师，生日快乐。谢谢你把耐心和热爱放进每一节课里，让很多个普通的下午变得闪闪发光。愿新的一岁，你也被温柔地照顾，被认真地爱着。",
    wishes: Array.from({ length: count }, (_, i) => {
      const [name, role, text] = SAMPLES[i % SAMPLES.length];
      return { name, role, text, media: i % 3 === 1 ? [{ url: `https://picsum.photos/seed/jsjy${i}/480/360`, kind: "image" as const }] : [] };
    }),
  };
}
