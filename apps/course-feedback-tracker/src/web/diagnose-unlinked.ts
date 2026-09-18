import { nameMatchKey } from "@/domain";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import type { UnlinkedResponse } from "./useWorkbenchData";

export type UnlinkedKind = "teacher-alias" | "student-alias" | "pair-missing" | "both-unknown";

export interface UnlinkedDiagnosis extends UnlinkedResponse {
  kind: UnlinkedKind;
  /** 一句话说清楚是什么问题 */
  reason: string;
  /** 需要加别名时，候选的课表规范名（按可能性排序） */
  candidates: string[];
  /** 加别名时要写进哪张表 */
  aliasKind?: "teacher" | "student";
}

/**
 * 判断一份答卷为什么对不上，并给出可操作的下一步。
 *
 * 真实数据里三种情况都出现过：
 *   老师名写法不同（Valentina 林 vs Valentina Lin）→ 加老师别名
 *   学生名写法不同（顾子言 vs 顾子言Tina）      → 加学生别名
 *   两个名字都在，但这对组合当月没排课            → 加别名没用，要么手动绑，要么去补课表
 */
export function diagnoseUnlinked(
  responses: readonly UnlinkedResponse[],
  tasks: readonly StoredFeedbackTask[],
): UnlinkedDiagnosis[] {
  const studentsByKey = new Map<string, string>();
  const teachersByKey = new Map<string, string>();
  const teachersOfStudent = new Map<string, Set<string>>();
  const studentsOfTeacher = new Map<string, Set<string>>();

  for (const task of tasks) {
    const studentKey = nameMatchKey(task.studentName);
    const teacherKey = nameMatchKey(task.teacherCanonicalName);
    studentsByKey.set(studentKey, task.studentName);
    teachersByKey.set(teacherKey, task.teacherCanonicalName);
    if (!teachersOfStudent.has(studentKey)) teachersOfStudent.set(studentKey, new Set());
    teachersOfStudent.get(studentKey)!.add(task.teacherCanonicalName);
    if (!studentsOfTeacher.has(teacherKey)) studentsOfTeacher.set(teacherKey, new Set());
    studentsOfTeacher.get(teacherKey)!.add(task.studentName);
  }

  const sortNames = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b, "zh-CN"));

  return responses.map((response) => {
    const studentKey = nameMatchKey(response.studentName);
    const teacherKey = nameMatchKey(response.teacherName);
    const studentKnown = studentsByKey.has(studentKey);
    const teacherKnown = teachersByKey.has(teacherKey);

    if (studentKnown && !teacherKnown) {
      return {
        ...response,
        kind: "teacher-alias",
        aliasKind: "teacher",
        reason: `老师「${response.teacherName}」不在本月课表里，可能是同一个人的另一种写法`,
        candidates: sortNames(teachersOfStudent.get(studentKey) ?? []),
      };
    }
    if (!studentKnown && teacherKnown) {
      return {
        ...response,
        kind: "student-alias",
        aliasKind: "student",
        reason: `学生「${response.studentName}」不在本月课表里，可能是同一个人的另一种写法`,
        candidates: sortNames(studentsOfTeacher.get(teacherKey) ?? []),
      };
    }
    if (studentKnown && teacherKnown) {
      return {
        ...response,
        kind: "pair-missing",
        reason: `两个名字都在本月课表里，但「${response.studentName} × ${response.teacherName}」这节课没排过——可能是评了更早的课，或课表漏排`,
        candidates: [],
      };
    }
    return {
      ...response,
      kind: "both-unknown",
      reason: "学生和老师都不在本月课表里，需要人工确认",
      candidates: [],
    };
  });
}
