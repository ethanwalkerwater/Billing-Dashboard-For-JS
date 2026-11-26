/**
 * 月度课程反馈的权限，存在 feedback_admins.role（迁移 202611110001_feedback_roles.sql），只管这一个产品。
 * - teacher：飞书登录自动开通。问卷跟踪、老师评分（分数、排名）、课程类型都能看，但看不到谁给了几分。
 * - admin：再加每份反馈明细、文字评价、导出反馈、发布定稿。
 * - super：admin 的全部权限，再加「管理员设置」里给别人改权限。
 * 数据库里 is_feedback_detail() 与 canViewDetail 同一口径，RLS 才是真正的门，前端只负责不显示。
 */
export type Role = "teacher" | "admin" | "super";

export const ROLES: Role[] = ["teacher", "admin", "super"];

export const ROLE_LABELS: Record<Role, string> = {
  teacher: "普通老师",
  admin: "可看反馈详情",
  super: "超级管理员",
};

export const canViewDetail = (role: Role | null | undefined) => role === "admin" || role === "super";

/** 会把逐份评分带回浏览器、或定稿评分的 feedback-api 操作。 */
export const ADMIN_ACTIONS = new Set(["publish-scores", "export-feedback-csv"]);

export type Page = "tracking" | "scores" | "course-types" | "admin";

/** 这个权限能进哪些页面；地址栏手动改 hash 进不去的页面一律回问卷跟踪。 */
export function allowedPages(role: Role): Page[] {
  return role === "super" ? ["tracking", "scores", "course-types", "admin"] : ["tracking", "scores", "course-types"];
}
