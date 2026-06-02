# 项目2 · 家长报告（parent-report）

基于学生的课时收费计算，为每位家长生成可分享的报告（HTML → PDF）。这是下游：
计算逻辑来自 [`packages/billing-core`](../../packages/billing-core)，本项目只负责排版与导出。

## 结构
```
src/
  parent-report-data.mjs          import "@jingshi/billing-core"，组织家长报告数据
  generate-parent-report.mjs      生成手机竖屏版 HTML
  generate-codex-parent-report.mjs
  export-parent-report-pdf.mjs    HTML → PDF（playwright-core）
  export-web-pdf.mjs
tests/
assets/teachers/                  老师头像图源
```

## 命令（在仓库根用 workspace 调用）
```bash
npm run generate    -w @jingshi/parent-report
npm run export:pdf  -w @jingshi/parent-report
npm run test        -w @jingshi/parent-report
```

## 共享数据约定
- 输入 CSV：仓库根 `data/raw/schedule.csv`（与项目1 共用同一份）
- 产物：仓库根 `outputs/parent_reports/`、`outputs/parent_reports_web/`
- 脚本内 `PROJECT_ROOT` 锚定到仓库根（`path.resolve(__dirname, "../../..")`），
  故无论从哪运行，data/outputs 路径都稳定。
