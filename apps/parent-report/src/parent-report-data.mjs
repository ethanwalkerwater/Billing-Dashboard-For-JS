import { buildReportFromCsv } from "@jingshi/billing-core";
import { createRequire } from "node:module";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const require = createRequire(import.meta.url);
const TEACHER_CATALOG = require("../data/teachers.json").teachers || [];
const TEACHER_ASSET_ROOT = "apps/parent-report/assets/teacher";
const TEACHER_IMAGES = Object.fromEntries(TEACHER_CATALOG
  .filter((teacher) => teacher.photo)
  .map((teacher) => [teacher.name, `${TEACHER_ASSET_ROOT}/${teacher.photo}`]));
const TEACHER_PROFILES = TEACHER_CATALOG.map((teacher) => ({
  name: teacher.name,
  actualName: teacher.name,
  image: teacher.photo ? `${TEACHER_ASSET_ROOT}/${teacher.photo}` : "",
  background: teacher.desc ? [teacher.desc] : ["菁仕授课团队成员。"],
}));

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
