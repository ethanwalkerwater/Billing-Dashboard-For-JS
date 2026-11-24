import type { LessonStats, TeacherRow } from "./dates";

export interface BlessingInput {
  name: string;
  subject: string;
  teaching: string;
  intro: string;
  stats: LessonStats | null;
  days: number | null;
  wishes: string[];
}

export function blessingMessages(input: BlessingInput): Array<{ role: "system" | "user"; content: string }> {
  const facts = [
    `老师：${input.name}（${input.subject || "学科未填"}）`,
    input.teaching && `教学特点：${input.teaching}`,
    input.intro && `个人介绍：${input.intro}`,
    input.days && `在菁仕的第 ${input.days} 天`,
    input.stats && `这一年：${input.stats.lessons} 节课、${input.stats.students} 位学生、${input.stats.hours} 小时`,
    input.wishes.length > 0 && `学生和同事的祝福（节选）：\n${input.wishes.slice(0, 20).map((w) => `- ${w}`).join("\n")}`,
  ].filter(Boolean);
  return [
    {
      role: "system",
      content:
        "你是菁仕教育的同事，为一位老师写生日寄语，放在生日祝福网页的最后。要求：中文，80–150 字，一段；温暖、真诚、具体，" +
        "从老师的教学特点和学生的祝福里取一两个细节；不提年龄，不编造成绩、数字或事件，不用「您」，不堆砌成语，不用破折号，不加标题、引号和落款。",
    },
    { role: "user", content: facts.join("\n") },
  ];
}

const TEMPLATES = [
  (n: string) => `${n}，生日快乐。谢谢你把耐心和热爱放进每一节课里，让很多个普通的下午变得闪闪发光。愿新的一岁，你也被温柔地照顾，被认真地爱着。`,
  (n: string) => `${n}，生日快乐！你点亮过的那些「原来如此」的瞬间，都悄悄长成了学生们的底气。愿你今天放下教案，好好被祝福一次。`,
  (n: string) => `${n}，生日快乐。讲台上的你认真又发光，讲台下的你也值得所有的好。愿这一年，所想皆如愿，所行皆坦途。`,
];

/** 同一位老师总拿到同一句模板，不同老师尽量不同。 */
export function templateBlessing(name: string): string {
  const seed = [...name].reduce((sum, ch) => sum + ch.codePointAt(0)!, 0);
  return TEMPLATES[seed % TEMPLATES.length](`${name}老师`);
}

export function chooseBlessing(teacher: Pick<TeacherRow, "name" | "handwritten" | "aiBlessing">): string {
  return teacher.handwritten.trim() || teacher.aiBlessing.trim() || templateBlessing(teacher.name);
}
