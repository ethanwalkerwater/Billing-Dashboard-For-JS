export const STUDENT_IDENTITY = "学生本人";
export const PARENT_IDENTITY = "家长/监护人";
export type MonthlyIdentity = typeof STUDENT_IDENTITY | typeof PARENT_IDENTITY;

export interface MonthlyTeacher {
  id: string;
  name: string;
  courses: string[];
  studentDone: boolean;
  parentDone: boolean;
  formUrl?: string;
}

export interface MonthlyFeedback {
  courseMonth: string;
  studentName: string;
  closed: boolean;
  teachers: MonthlyTeacher[];
}

export function monthlyFeedbackTitle(courseMonth: string, studentName: string): string {
  return `${Number(courseMonth.slice(5))}月 · ${studentName} · 月度反馈`;
}

export function monthlyTaskKey(task: { courseMonth: string; studentRecordId: string }): string {
  return `${task.courseMonth}/${task.studentRecordId}`;
}

export function uniqueStudentMonths<T extends { courseMonth: string; studentRecordId: string }>(tasks: readonly T[]): T[] {
  return [...new Map(tasks.map((task) => [monthlyTaskKey(task), task])).values()];
}

export function monthlyTeacherDone(teacher: MonthlyTeacher, identity?: MonthlyIdentity): boolean {
  if (!identity) return teacher.studentDone || teacher.parentDone;
  return identity === PARENT_IDENTITY ? teacher.parentDone : teacher.studentDone;
}

export function nextMonthlyTeacher(teachers: readonly MonthlyTeacher[], identity?: MonthlyIdentity, after?: string): MonthlyTeacher | undefined {
  const index = after ? teachers.findIndex((teacher) => teacher.id === after) : -1;
  return [...teachers.slice(index + 1), ...teachers.slice(0, index + 1)].find((teacher) => !monthlyTeacherDone(teacher, identity));
}
