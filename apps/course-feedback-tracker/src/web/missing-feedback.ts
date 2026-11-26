import { nameMatchKey, shiftMonth } from "@/domain";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import type { DetailRow } from "./report-types";

export interface MissingStudent {
  student: string;
  hours: number;
  courses: string[];
  /** 任务标了拒绝填写 */
  declined: boolean;
}

export interface StudentCourseTrend {
  currentMonth: string;
  currentLessons: number | null;
  nextMonth: string;
  nextLessons: number | null;
}

function lessonCount(tasks: StoredFeedbackTask[] | null, teacher: string, student: string): number | null {
  if (!tasks) return null;
  const teacherKey = nameMatchKey(teacher);
  const studentKey = nameMatchKey(student);
  return tasks.reduce((sum, task) => {
    if (nameMatchKey(task.teacherCanonicalName) !== teacherKey || nameMatchKey(task.studentName) !== studentKey) return sum;
    return sum + (task.lessons?.length ?? task.scheduleRecordIds.length);
  }, 0);
}

/** 同一学生与老师的当月/次月课程数；null 表示该月课表还没同步。 */
export function studentCourseTrend(input: {
  courseMonth: string;
  teacher: string;
  student: string;
  currentTasks: StoredFeedbackTask[] | null;
  nextTasks: StoredFeedbackTask[] | null;
}): StudentCourseTrend {
  return {
    currentMonth: input.courseMonth,
    currentLessons: lessonCount(input.currentTasks, input.teacher, input.student),
    nextMonth: shiftMonth(input.courseMonth, 1),
    nextLessons: lessonCount(input.nextTasks, input.teacher, input.student),
  };
}

function lessonHours(task: StoredFeedbackTask): number {
  return (task.lessons ?? []).reduce((sum, lesson) => sum + (Number(lesson["课程时长"]) || 0), 0);
}

/**
 * 这位老师当月课表上有课、但还没有对上反馈的学生。
 * 覆盖率 = 有反馈的学生课时 / 总课时；名单按课时从多到少排，方便先追课时多的。
 */
export function missingStudentsForTeacher(input: {
  teacher: string;
  tasks: StoredFeedbackTask[];
  detail: DetailRow[];
  excludedStudents?: Iterable<string>;
}): MissingStudent[] {
  const teacherKey = nameMatchKey(input.teacher);
  const excluded = new Set([...(input.excludedStudents ?? [])].map(nameMatchKey));
  const responded = new Set(
    input.detail
      .filter((row) => nameMatchKey(row.teacher) === teacherKey && row.matched)
      .map((row) => nameMatchKey(row.student)),
  );

  const byStudent = new Map<string, MissingStudent>();
  for (const task of input.tasks) {
    if (nameMatchKey(task.teacherCanonicalName) !== teacherKey) continue;
    const key = nameMatchKey(task.studentName);
    if (!key || excluded.has(key)) continue;
    if (responded.has(key) || task.studentResponseId || task.parentResponseId) continue;

    const hours = lessonHours(task);
    const current = byStudent.get(key);
    if (current) {
      current.hours += hours;
      current.courses = [...new Set([...current.courses, ...task.courseNames])];
      current.declined = current.declined || task.status === "declined";
    } else {
      byStudent.set(key, {
        student: task.studentName,
        hours,
        courses: [...task.courseNames],
        declined: task.status === "declined",
      });
    }
  }

  return [...byStudent.values()].sort(
    (left, right) => right.hours - left.hours || left.student.localeCompare(right.student, "zh-CN"),
  );
}
