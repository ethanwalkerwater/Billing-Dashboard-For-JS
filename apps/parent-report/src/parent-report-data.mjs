import { buildReportFromCsv } from "@jingshi/billing-core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const TEACHER_IMAGES = {
  应雁心: "apps/parent-report/assets/teachers/应老师.png",
  李品轩: "apps/parent-report/assets/teachers/李老师.png",
};

const TEACHER_PROFILES = [
  { name: "Lisa老师", actualName: "Lisa老师", image: "apps/parent-report/assets/teachers/Lisa老师.png", background: ["国际双语物理教学背景，擅长 IGCSE 与 Alevel 物理基础搭建。"] },
  { name: "傅老师", actualName: "傅威程", image: "apps/parent-report/assets/teachers/傅老师.png", background: ["金融科技与数学竞赛背景，擅长数学竞赛、逻辑训练与阶段性拔高。"] },
  { name: "包老师", actualName: "包天翊", image: "apps/parent-report/assets/teachers/包老师.png", background: ["金融数学背景，擅长 Alevel 数学、IB 数学与高阶数学思维训练。"] },
  { name: "应老师", actualName: "应雁心", image: "apps/parent-report/assets/teachers/应老师.png", background: ["国际课程亲历者，擅长 Alevel 高数、数学刷题与体系化复盘。"] },
  { name: "张老师", actualName: "张文豪", image: "apps/parent-report/assets/teachers/张老师.png", background: ["数学与应用数学背景，擅长 Alevel 数学、IB 数学与 AP 数学。"] },
  { name: "张老师", actualName: "张劭景", image: "apps/parent-report/assets/teachers/张老师-1.png", background: ["英式数学教育背景，擅长 IGCSE 与 A-level 数学。"] },
  { name: "朱老师", actualName: "朱毅博", image: "apps/parent-report/assets/teachers/朱老师.png", background: ["化学工程与生物科技背景，擅长 SAT 科学、Alevel 生化与竞赛辅导。"] },
  { name: "朱老师", actualName: "朱凯宁", image: "apps/parent-report/assets/teachers/朱老师-1.png", background: ["中文教育背景，擅长语文阅读、写作表达与国际学校中文课程。"] },
  { name: "李老师", actualName: "李品轩", image: "apps/parent-report/assets/teachers/李老师.png", background: ["国际教育与生物科学背景，擅长 Alevel 物理、物理刷题与科学课程。"] },
  { name: "林老师", actualName: "Valentina Lin", image: "apps/parent-report/assets/teachers/林老师.png", background: ["英语文学背景，擅长英语文学、写作、EFL/ESL 与学术表达。"] },
  { name: "汤老师", actualName: "汤朔", image: "apps/parent-report/assets/teachers/汤老师.png", background: ["建筑与物理背景，擅长 AMC、IGCSE 数学与物理课程。"] },
  { name: "王老师", actualName: "王储君", image: "apps/parent-report/assets/teachers/王老师.png", background: ["英语教学背景，擅长雅思、托福、剑桥英语与青少年英语能力培养。"] },
  { name: "秦北辰", actualName: "秦北辰", image: "apps/parent-report/assets/teachers/秦北辰.png", background: ["经济学背景，擅长 Alevel 经济与申请方向学术支持。"] },
  { name: "罗建文", actualName: "罗健文", image: "apps/parent-report/assets/teachers/罗建文.png", background: ["会计金融背景，擅长 Alevel 会计、IGCSE 会计与商科课程。"] },
  { name: "蒋老师", actualName: "蒋妍", image: "apps/parent-report/assets/teachers/蒋老师.png", background: ["工商管理与双语教学背景，擅长中文、PBL 项目与低龄学科启蒙。"] },
  { name: "蓝老师", actualName: "蓝浪", image: "apps/parent-report/assets/teachers/蓝老师.png", background: ["教育政策与英语语言文学背景，擅长雅思、托福与英文阅读写作。"] },
  { name: "邓老师", actualName: "邓老师（地理）", image: "apps/parent-report/assets/teachers/邓老师.png", background: ["统计与计算机背景，擅长数学、统计、计算机课程与美高体系辅导。"] },
  { name: "郑老师", actualName: "郑唯梓", image: "apps/parent-report/assets/teachers/郑老师.png", background: ["北大理科背景，擅长 IGCSE/A-Level 数学与物理、数学竞赛。"] },
  { name: "陈老师", actualName: "陈璐怡", image: "apps/parent-report/assets/teachers/陈老师.png", background: ["TESOL 与英语教学背景，擅长托福、SAT/ACT 文法与英语全科。"] },
  { name: "陈老师", actualName: "陈依依", image: "apps/parent-report/assets/teachers/陈老师-1.png", background: ["牛津生物化学研究背景，擅长 IGCSE/A-Level 数学、物理、化学与 IB 课程。"] },
  { name: "黄老师", actualName: "黄钢", image: "apps/parent-report/assets/teachers/黄老师.png", background: ["翻译学背景，擅长雅思、托福、Alevel 文学与英文写作。"] },
];

const TEACHER_BACKGROUND = {
  应雁心: [
    "伦敦大学学院背景，国际课程亲历者。",
    "本月负责 Alevel 高数与数学刷题班，重点覆盖函数、微积分与综合题型训练。",
  ],
  李品轩: [
    "西交利物浦大学国际教育专业硕士，生物科学本科。",
    "本月负责 Alevel 物理与物理刷题班，强化模型识别、实验题表达和高频考点。",
  ],
  高老师: [
    "物理刷题班授课老师。",
    "本月参与专项练习、课堂答疑与阶段薄弱点巩固。",
  ],
};

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function dateParts(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  return { year, month, day };
}

function monthLabel(month) {
  const [year, value] = month.split("-");
  return `${year}年${Number(value)}月`;
}

function displayDate(dateText) {
  const { month, day } = dateParts(dateText);
  return `${month}/${day}`;
}

function displayStudentName(student) {
  return student.replace(/-\d+$/, "");
}

function cancellationRateLabel(status) {
  const match = String(status || "").match(/(\d+)%/);
  return match ? `${match[1]}%` : "";
}

function billingFields(status, grossAmount, payableAmount) {
  const isLeave = status !== "正常上课";
  const waivedAmount = grossAmount - payableAmount;
  const rateLabel = cancellationRateLabel(status);
  return {
    isLeave,
    cancellationRateLabel: rateLabel,
    cancellationChargeAmount: isLeave ? money(payableAmount) : 0,
    waivedAmount: money(waivedAmount),
    billingNote: isLeave && rateLabel ? `请假扣费 ${rateLabel}` : "正常计费",
  };
}

function lessonSort(a, b) {
  return `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`);
}

function buildCourseLines(result, data) {
  return result.groups.map((group) => {
    const records = group.rawRows.map((rawRow) => data.recordsByRow[String(rawRow)]).filter(Boolean);
    const grossAmount = records.reduce((sum, record) => sum + Number(record.unitPrice || 0) * Number(record.duration || 0), 0);
    const payableAmount = records.reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const discountAmount = grossAmount - payableAmount;
    const billing = billingFields(group.cancellationStatus, grossAmount, payableAmount);
    const discountText = discountAmount > 0
      ? `${Math.round((discountAmount / grossAmount) * 100)}% 减免`
      : "无";

    return {
      teacher: group.counterparty,
      courseType: group.courseType,
      teachingType: group.teachingType,
      status: group.cancellationStatus,
      lessonCount: group.lessons,
      duration: group.duration,
      unitPriceLabel: group.unitPriceLabel,
      grossAmount: money(grossAmount),
      discountText,
      discountAmount: money(discountAmount),
      ...billing,
      payableAmount: money(payableAmount),
      rawRows: group.rawRows,
    };
  });
}

function buildLessons(result, data) {
  return [...new Set(result.groups.flatMap((group) => group.rawRows))]
    .map((rawRow) => data.recordsByRow[String(rawRow)])
    .filter(Boolean)
    .sort(lessonSort)
    .map((record) => {
      const grossAmount = Number(record.unitPrice || 0) * Number(record.duration || 0);
      const payableAmount = Number(record.amount || 0);
      const discountAmount = grossAmount - payableAmount;
      const billing = billingFields(record.cancellationStatus, grossAmount, payableAmount);
      return {
        rawRow: record.rawRow,
        date: record.date,
        displayDate: displayDate(record.date),
        weekday: record.weekday,
        startTime: record.startTime,
        endTime: record.endTime,
        teacher: record.teacher,
        courseType: record.courseType,
        teachingType: record.teachingType,
        status: record.cancellationStatus,
        isLeave: record.isCancelled,
        leaveLabel: record.isCancelled ? "请假 · 临时取消" : "",
        unitPrice: record.unitPrice,
        duration: record.duration,
        grossAmount: money(grossAmount),
        discountAmount: money(discountAmount),
        ...billing,
        payableAmount: money(payableAmount),
        location: record.location,
      };
    });
}

function buildCalendar(month, lessons) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const cells = [];

  for (let i = 0; i < first.getDay(); i += 1) {
    cells.push({ inMonth: false, day: "", date: "", lessons: [] });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({
      inMonth: true,
      day,
      date,
      lessons: lessons.filter((lesson) => lesson.date === date),
    });
  }

  while (cells.length % 7 !== 0) {
    cells.push({ inMonth: false, day: "", date: "", lessons: [] });
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return { weekdays: WEEKDAYS, weeks };
}

function buildTeacherMonthlyStats(data, month) {
  const stats = new Map();
  for (const result of Object.values(data.views.teacher?.[month] || {})) {
    stats.set(result.entity, {
      monthlyTotalDuration: money(result.totals.duration),
      monthlyTotalLessons: result.totals.lessons,
    });
  }
  return stats;
}

function monthlyStatsFor(monthlyStats, teacherName) {
  return monthlyStats.get(teacherName) || {
    monthlyTotalDuration: 0,
    monthlyTotalLessons: 0,
  };
}

function buildTeachers(lessons, monthlyStats) {
  const byTeacher = new Map();
  for (const lesson of lessons) {
    if (!byTeacher.has(lesson.teacher)) {
      byTeacher.set(lesson.teacher, {
        name: lesson.teacher,
        courses: new Set(),
        teachingTypes: new Set(),
        lessonCount: 0,
        duration: 0,
        firstLesson: `${lesson.date} ${lesson.startTime}`,
      });
    }
    const teacher = byTeacher.get(lesson.teacher);
    teacher.courses.add(lesson.courseType);
    teacher.teachingTypes.add(lesson.teachingType);
    teacher.lessonCount += 1;
    teacher.duration += Number(lesson.duration || 0);
  }

  return [...byTeacher.values()]
    .sort((a, b) => a.firstLesson.localeCompare(b.firstLesson))
    .map((teacher) => {
      const stats = monthlyStatsFor(monthlyStats, teacher.name);
      return {
        name: teacher.name,
        actualName: teacher.name,
        courses: [...teacher.courses],
        teachingTypes: [...teacher.teachingTypes],
        studentLessonCount: teacher.lessonCount,
        studentDuration: money(teacher.duration),
        focus: [...teacher.courses].join(" / "),
        image: TEACHER_IMAGES[teacher.name] || "",
        background: TEACHER_BACKGROUND[teacher.name] || ["菁仕授课团队成员。"],
        monthlyScore: null,
        ...stats,
      };
    });
}

function buildMoreTeachers(activeTeachers, monthlyStats) {
  const activeActualNames = new Set(activeTeachers.map((teacher) => teacher.actualName).filter(Boolean));
  return TEACHER_PROFILES
    .filter((teacher) => !activeActualNames.has(teacher.actualName))
    .map((teacher) => ({
      ...teacher,
      courses: [],
      teachingTypes: [],
      ...monthlyStatsFor(monthlyStats, teacher.actualName),
      monthlyScore: null,
    }));
}

export function buildParentReportData(csvText, options) {
  const student = options.student;
  const month = options.month;
  const data = buildReportFromCsv(csvText, "schedule.csv");
  const result = data.views.student?.[month]?.[student];
  if (!result) {
    throw new Error(`No billing data found for ${student} in ${month}`);
  }

  const courseLines = buildCourseLines(result, data);
  const lessons = buildLessons(result, data);
  const monthlyStats = buildTeacherMonthlyStats(data, month);
  const teachers = buildTeachers(lessons, monthlyStats);
  const grossAmount = courseLines.reduce((sum, line) => sum + line.grossAmount, 0);
  const payableAmount = courseLines.reduce((sum, line) => sum + line.payableAmount, 0);
  const discountAmount = grossAmount - payableAmount;

  return {
    brandName: "菁仕",
    brandEnglish: "King's Academy",
    studentId: student,
    studentName: displayStudentName(student),
    month,
    monthLabel: monthLabel(month),
    generatedDate: new Date().toISOString().slice(0, 10),
    totals: {
      lessonCount: result.totals.lessons,
      duration: result.totals.duration,
      grossAmount: money(grossAmount),
      discountAmount: money(discountAmount),
      payableAmount: money(payableAmount),
      cancelledLessons: result.totals.cancelledLessons,
      cancelledAmount: result.totals.cancelledAmount,
    },
    courseLines,
    lessons,
    calendar: buildCalendar(month, lessons),
    teachers,
    moreTeachers: buildMoreTeachers(teachers, monthlyStats),
  };
}
