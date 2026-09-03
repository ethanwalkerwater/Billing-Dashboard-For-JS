# 项目2 · 家长报告（parent-report）

基于学生的课时收费计算，为每位家长生成可分享的报告（HTML → PDF）。这是下游：
计算逻辑来自 [`packages/billing-core`](../../packages/billing-core)，本项目只负责排版与导出。

## 结构

```
web/                              浏览器端上传、校对、师资库与批量下载
api/
  generate-report.mjs             Vercel PDF Function 入口
  generate-student-billing-pdf.mjs Chromium、字体与 PDF 完整性校验
src/
  parent-report-data.mjs          import "@jingshi/billing-core"，组织家长报告数据
  student-billing-batch-data.mjs  解析完整课时费与公共课表
  render-student-billing-report.mjs 五段式家长账单模板
  generate-parent-report.mjs      生成手机竖屏版 HTML
  generate-codex-parent-report.mjs
  export-parent-report-pdf.mjs    HTML → PDF（playwright-core）
  export-web-pdf.mjs
tests/
assets/teacher/                   老师头像和师资卡数据源
assets/teacher-optimized/         Vercel 使用的压缩头像
assets/fonts/                     Serverless Chromium 使用的中文字体与许可证
```

## 命令（在仓库根用 workspace 调用）
```bash
npm run dev       -w @jingshi/parent-report
npm run build     -w @jingshi/parent-report
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

## 在线操作

网页依次接收三类 UTF-8 CSV：

1. 学生课时情况，可一次选择多份；
2. 排课系统导出的完整课表；
3. 老师反馈模块导出的历史累计老师评分。

CSV 在浏览器内解析，只有用户校对并确认后的单个学生报告数据会提交给 PDF Function。网页支持修正课时、价格、取消比例、老师与授课类型；手动覆盖应付金额时必须填写修改原因。批量生成前会列出每位学生、月份、行号和具体错误。

## 累计老师评分更新

师资卡只使用 `teacher-feedback` 生成的历史累计评分，不能用单月
`teacher_scores.csv` 直接覆盖。累计模块先复用月度算法，再按老师每月的实际授课
课时加权，权威文件为 `outputs/teacher-feedback/cumulative/teacher_scores.csv`。

每个月新增反馈和课表数据后，运行一条命令重算累计评分、同步师资卡并重新生成师资数据：

```bash
npm run update:parent-teacher-scores
```

同步脚本会把累计文件的学习提升、责任心与服务态度、个人魅力三项分数按一位小数
写回 `assets/teacher/老师卡片.txt`。这样 Vercel 不需要访问本地 `outputs/`，线上构建
仍能得到已确认的历史累计评分。累计文件中的总评分和排名仅用于审计，不显示在师资卡。

新月份的 `respondent_detail.csv`、`teacher_text_feedback.csv`、`teacher_summary.csv`
等评价记录应保留在 `outputs/teacher-feedback/<YYYY-MM>/`。原始反馈仍只放在
`data/local/teacher-feedback/`，不得提交或部署。

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

PDF 按封面、课程明细、月历、师资团队和结束页分段输出。每页保留背景、图片与可搜索文字。

## Vercel PDF 与字体

Vercel Lambda 没有 macOS 中文字体。Function 随部署包携带 `NotoSerifSC-Regular.ttf`，启动 Chromium 前会显式创建 `/tmp/fonts/fonts.conf`，设置 `FONTCONFIG_PATH` 和 `FONTCONFIG_FILE`，再注册字体。不要把字体栈改回只依赖 `Songti SC`、`STSong` 或 `PingFang SC`。

生成前会等待 `document.fonts` 和全部老师图片；生成后会检查每一页是否包含字体资源。Serverless 矢量打印如仍异常，会对已完成字体渲染的页面做逐页图像降级，避免返回只有边框和图片、没有可见文字的 PDF。

Vercel 的可写 `/tmp` 只有 500 MB，而解压后的 Chromium 与运行库会固定占用约 203 MiB。每次 PDF 请求必须使用 `/tmp/jingshi-parent-report/session-*` 下独立的 profile、artifacts 和 1 MiB 磁盘缓存，并在浏览器 context 关闭后删除整个请求目录。只允许回收超过 15 分钟的同前缀陈旧目录；不得清空 `/tmp`，也不得删除共享的 `/tmp/chromium`、`/tmp/fonts` 或 `/tmp/fonts-cache`。这项隔离同时保护 Vercel Fluid Compute 下可能并行执行的请求。

字体或 PDF 逻辑变更不能只做本地验证。至少需要：

```bash
npm run test -w @jingshi/parent-report
npm run build -w @jingshi/parent-report
```

然后在 Vercel 预览部署中用包含中文学生名、课程名和老师介绍的真实结构 fixture 调用 `/api/generate-report`，并用 `pdffonts`、`pdftotext` 和逐页渲染同时验收。

## 图片工具

ImageMagick 是可选优化依赖。安装 `magick` 后，报告会压缩和裁剪老师头像；未安装时会直接使用原图，不会阻断 HTML 生成。
