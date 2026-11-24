/** 负责教务。列表里「负责人」一列的选项；加人只改这里。 */
export const TASK_OWNERS = ["傅威程", "Tinko", "华心晨"] as const;

/**
 * 教务在某个课程月份给一对学生-老师设的负责人（表 feedback_owner_assignments）。
 * 只存手动设的那一次，之后的月份没有自己的设定就沿用它：9 月设了华心晨，10、11 月都是华心晨；
 * 10 月改成 Tinko，就从 10 月起是 Tinko。新生成的名单、之前已经生成的名单都实时跟着变。
 */
export interface OwnerAssignment {
  studentRecordId: string;
  teacherCanonicalName: string;
  /** 从这个课程月份起生效 */
  fromMonth: string;
  owner: string;
}

export interface ResolvedOwner {
  owner: string;
  /** 设定来自哪个课程月份；和任务的课程月份不同就是沿用的 */
  fromMonth: string;
}

/**
 * 这个月的负责人：同一对学生-老师在本月或之前最近的设定；这对是新的（换了老师），就用同一学生最近的设定。
 */
export function ownerResolver(assignments: readonly OwnerAssignment[]) {
  // 按月份从近到远，取第一条符合的
  const sorted = [...assignments].sort((a, b) => b.fromMonth.localeCompare(a.fromMonth));
  return (task: { studentRecordId: string; teacherCanonicalName: string; courseMonth: string }): ResolvedOwner | undefined => {
    const earlier = sorted.filter((row) => row.studentRecordId === task.studentRecordId && row.fromMonth <= task.courseMonth);
    const hit = earlier.find((row) => row.teacherCanonicalName === task.teacherCanonicalName) ?? earlier[0];
    return hit ? { owner: hit.owner, fromMonth: hit.fromMonth } : undefined;
  };
}
