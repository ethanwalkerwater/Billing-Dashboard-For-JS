import { canonicalizeName, createStableTaskId } from "./identity";
import { classifyLesson } from "./lesson-kind";
import { collectionMonthToCourseMonth, isWithinMonthInShanghai } from "./month";
import type {
  FeedbackTaskDraft,
  GroupingOptions,
  GroupingResult,
  ScheduleRecord,
  StudentRecord,
} from "./types";

interface TaskAccumulator {
  courseMonth: string;
  collectionMonth: string;
  studentRecordId: string;
  studentName: string;
  teacherSourceName: string;
  teacherCanonicalName: string;
  courseNames: Set<string>;
  scheduleRecordIds: Set<string>;
}

function uniqueCanonical(values: string[]): string[] {
  return [...new Set(values.map(canonicalizeName).filter(Boolean))];
}

function getRecordProblems(
  record: ScheduleRecord,
  students: ReadonlyMap<string, StudentRecord>,
): string[] {
  const problems: string[] = [];
  if (record.studentRecordIds.length === 0) problems.push("缺少学生");
  if (record.teacherNames.length === 0) problems.push("缺少老师");
  if (record.courseNames.length === 0) problems.push("缺少课程名称");
  for (const studentId of record.studentRecordIds) {
    if (!students.has(studentId)) problems.push(`学生关联不存在：${studentId}`);
  }
  return problems;
}

export async function groupScheduleIntoTasks(
  records: ScheduleRecord[],
  studentRecords: StudentRecord[],
  options: GroupingOptions,
): Promise<GroupingResult> {
  const courseMonth = collectionMonthToCourseMonth(options.collectionMonth);
  const students = new Map(studentRecords.map((student) => [student.recordId, student]));
  const teacherAliases = options.teacherAliases ?? {};
  const grouped = new Map<string, TaskAccumulator>();
  const excludedRecords: GroupingResult["excludedRecords"] = [];
  const reviewRecords: GroupingResult["reviewRecords"] = [];
  const invalidRecords: GroupingResult["invalidRecords"] = [];

  for (const record of records) {
    if (!record.startsAt) {
      invalidRecords.push({ recordId: record.recordId, reasons: ["缺少上课时间"] });
      continue;
    }
    // 其他月份的课程是绝大多数，直接跳过，不当成"数据有问题"报给教务。
    if (!isWithinMonthInShanghai(record.startsAt, courseMonth)) continue;

    const courses = uniqueCanonical(record.courseNames);

    // 排除判断必须排在缺字段判断前面：请假、考试、自习这类记录本来就没有老师或学生，
    // 先查缺字段会把它们全报成"课表数据有问题"，异常清单就没法用了。
    const cancellationTag = uniqueCanonical(record.cancellationTags)[0];
    if (cancellationTag) {
      excludedRecords.push({ recordId: record.recordId, reason: `临时取消：${cancellationTag}` });
      continue;
    }
    // 不是课程（咨询、考试、会议、自习、作业…）的不发问卷，判断和老师评分共用 classifyLesson。
    const kind = classifyLesson({ courseTypes: record.courseNames, teachingTypes: record.teachingTypes }, options.courseTypeOverrides);
    if (!kind.isCourse) {
      excludedRecords.push({ recordId: record.recordId, reason: `非课程：${kind.reason}` });
      continue;
    }

    const problems = getRecordProblems(record, students);
    if (problems.length > 0) {
      // 没标授课类型、又缺老师或学生，说明它根本不是一节课，归到排除而不是"要去飞书修数据"。
      if (kind.source === "default") {
        excludedRecords.push({ recordId: record.recordId, reason: `非课程：未标注授课类型且${problems[0]}` });
      } else {
        invalidRecords.push({ recordId: record.recordId, reasons: [...new Set(problems)] });
      }
      continue;
    }
    if (kind.source === "default") {
      reviewRecords.push({ recordId: record.recordId, reason: kind.reason });
    }

    for (const studentId of record.studentRecordIds) {
      const student = students.get(studentId);
      if (!student) continue;
      for (const sourceTeacher of uniqueCanonical(record.teacherNames)) {
        const teacherCanonicalName = canonicalizeName(teacherAliases[sourceTeacher] ?? sourceTeacher);
        const groupKey = [courseMonth, studentId, teacherCanonicalName].join("");
        const existing = grouped.get(groupKey) ?? {
          courseMonth,
          collectionMonth: options.collectionMonth,
          studentRecordId: studentId,
          studentName: canonicalizeName(student.name),
          teacherSourceName: sourceTeacher,
          teacherCanonicalName,
          courseNames: new Set<string>(),
          scheduleRecordIds: new Set<string>(),
        };
        for (const course of courses) existing.courseNames.add(course);
        existing.scheduleRecordIds.add(record.recordId);
        grouped.set(groupKey, existing);
      }
    }
  }

  const tasks: FeedbackTaskDraft[] = [];
  for (const value of grouped.values()) {
    tasks.push({
      taskId: await createStableTaskId(value),
      courseMonth: value.courseMonth,
      collectionMonth: value.collectionMonth,
      studentRecordId: value.studentRecordId,
      studentName: value.studentName,
      teacherSourceName: value.teacherSourceName,
      teacherCanonicalName: value.teacherCanonicalName,
      courseNames: [...value.courseNames].sort((left, right) => left.localeCompare(right, "zh-CN")),
      scheduleRecordIds: [...value.scheduleRecordIds].sort(),
    });
  }

  tasks.sort((left, right) => {
    const teacher = left.teacherCanonicalName.localeCompare(right.teacherCanonicalName, "zh-CN");
    return teacher || left.studentName.localeCompare(right.studentName, "zh-CN");
  });

  return { tasks, excludedRecords, reviewRecords, invalidRecords };
}
