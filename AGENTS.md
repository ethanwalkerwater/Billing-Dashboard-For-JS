# AGENTS.md — 菁仕教育服务

## 领域地图

- **课时账单**：`apps/billing-report`，面向学生收费明细。
- **老师收入**：`apps/teacher-income-report`，面向老师收入与公司成本。
- **老师反馈**：`apps/teacher-feedback`，把反馈表和课表生成老师月度评分。
- **家长报告**：`apps/parent-report`，本地生成家长 HTML/PDF。
- **雅思正向率**：`apps/ielts-progress`，飞书录入雅思成绩，按课表归属老师，看老师的学生正向率（CloudBase）。
- **老师生日**：`apps/teacher-birthday`，飞书老师档案 + 生日前问卷与当天群卡片 + 3D 祝福网页（CloudBase）。
- **学生取消课程**：`apps/course-feedback-tracker` 里的独立模块（云函数 `cancel-api` + 页面 `/cancel/`），学生自助取消、写课表「临时取消」、飞书通知老师，见 `apps/course-feedback-tracker/docs/lesson-cancellation.md`。
- **菁仕课堂（录课）**：`apps/classroom-recorder`，老师端 Mac/Windows 录课 App（Tauri）+ CloudBase 云函数 `classroom-api`（飞书登录、分段上传、腾讯云转写、家长总结）+ 完整报告网页与后台（录音 / 转写 / 报告查看、提示词调试与发布）`/classroom/`。UI 以 `docs/MVP.html`、`docs/classroom-report.html` 为准，接口约定见 `apps/classroom-recorder/docs/design.md`。
- **计费内核**：`packages/billing-core`，课时、取消、金额和薪资计算唯一真源。

## 依赖关系

`billing-report` 和 `teacher-income-report` 依赖 `billing-core`。修改计费规则时必须同时运行核心、账单和收入测试。

`teacher-feedback` 是独立 Python 应用，不复制 JavaScript 计费实现。它通过 `teacher_summary.csv` 等产物与 `parent-report` 连接。

## 常用验证

```bash
npm test
npm run build:billing-report
npm run build:teacher-income-report
npm run build:teacher-feedback
```

## 数据安全

真实输入只允许出现在 `data/local/`，生成结果只允许出现在 `outputs/`。两者都不入 Git 或 Vercel。各模块的数据接口以 `data/README.md` 为准，不得重新创建 `data/raw/`、`data/private/`、`data/payroll/` 等旧目录，也不得把真实 CSV 复制到应用源码或 Vercel 静态目录。业务方已确认可公开的老师收入主数据例外放在 `apps/teacher-income-report/web/assets/payroll/defaults.json`，该文件可随应用部署。

## 部署边界

三个线上应用分别对应三个 Vercel Project。不要把多个服务合并成一个 Vercel Project，也不要让老师反馈 Function 读取仓库外的绝对路径。
