# AGENTS.md — 菁仕后台服务

## 领域地图

- **课时账单**：`apps/billing-report`，面向学生收费明细。
- **老师收入**：`apps/teacher-income-report`，面向老师收入与公司成本。
- **老师反馈**：`apps/teacher-feedback`，把反馈表和课表生成老师月度评分。
- **家长报告**：`apps/parent-report`，本地生成家长 HTML/PDF。
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

真实数据只允许出现在 `data/raw/`、`data/private/` 和 `outputs/`。这些目录不入 Git。不得把真实 CSV 复制到应用源码目录或 Vercel 静态目录。

## 部署边界

三个线上应用分别对应三个 Vercel Project。不要把多个服务合并成一个 Vercel Project，也不要让老师反馈 Function 读取仓库外的绝对路径。
