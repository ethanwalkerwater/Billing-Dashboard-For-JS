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
assets/teacher/                   老师头像和师资卡数据源
```

## 命令（在仓库根用 workspace 调用）
```bash
npm run generate    -w @jingshi/parent-report
npm run generate:student-billing -w @jingshi/parent-report
npm run generate:student-billing-pdf -w @jingshi/parent-report
npm run export:pdf  -w @jingshi/parent-report
npm run test        -w @jingshi/parent-report
```

## 共享数据约定
- 公共课表：仓库根 `data/local/shared/schedule.csv`（与课时账单、老师反馈共用同一份）
- 产物：仓库根 `outputs/parent_reports/`、`outputs/parent_reports_web/`
- 脚本内 `PROJECT_ROOT` 锚定到仓库根（`path.resolve(__dirname, "../../..")`），
  故无论从哪运行，data/outputs 路径都稳定。
- 完整的跨 app 数据约定见 [`data/README.md`](../../data/README.md)。

## 批量生成学生课时费明细 HTML

1. 把完整课时费 CSV 放到仓库根目录的 `data/local/parent-report/complete-billing/`。
2. 确认原始课表位于 `data/local/shared/schedule.csv`。
3. 如需更新师资卡，编辑 `apps/parent-report/assets/teacher/老师卡片.txt` 和同目录头像。
4. 运行：

   ```bash
   npm run generate:student-billing -w @jingshi/parent-report
   ```

5. 生成结果位于：

   ```text
   outputs/parent_reports/generated/
   ```

命名规则为 `学生姓名-月份.html`，例如 `Daniel 周恩东-2026-03.html`。学生姓名会自动去掉末尾编号，例如 `Daniel 周恩东-3735` 会显示为 `Daniel 周恩东`。

老师卡片规则：当月授课老师如果存在于 `老师卡片.txt`，会进入「授课老师」；未收录老师仍显示在课程明细和课表里，但不显示卡片；其余已收录老师显示在「更多老师」。

如需直接生成最终交付给家长的连续长页 PDF，运行：

```bash
npm run generate:student-billing-pdf -w @jingshi/parent-report
```

PDF 输出位于：

```text
outputs/parent_reports/generated_pdfs/
```

PDF 使用 Chromium 的矢量 PDF 输出，保留背景和图片，单份报告是一页连续长页，避免 A4 分页截断。

## 图片工具

ImageMagick 是可选优化依赖。安装 `magick` 后，报告会压缩和裁剪老师头像；未安装时会直接使用原图，不会阻断 HTML 生成。
