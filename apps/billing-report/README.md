# 项目1 · 菁仕课时收费报表（billing-report）

上传 CSV → 计算每个学生/老师的收费与收入。这是上游：家长报告（项目2）依赖它的计算结果。

## 结构
```
web/                浏览器原生 ESM 静态站（部署到 Vercel）
  index.html
  assets/app.js     import "./report-core.js"
  assets/styles.css
  assets/report-core.js   ← 生成物，由 sync-core 从 billing-core 拷入（不入库）
python/             Python 版（与网页版并行使用）
  course_billing_report.py
  tests/
scripts/            sync-core / build-static / verify-static-app
vercel.json
```

## 命令（在仓库根用 workspace 调用）
```bash
npm run dev   -w @jingshi/billing-report      # 本地起静态站 :4173
npm run build -w @jingshi/billing-report      # 生成 dist/ 并校验
npm run test  -w @jingshi/billing-report      # 校验静态站
npm run test:python -w @jingshi/billing-report
```

计算逻辑不在本项目，统一在 [`packages/billing-core`](../../packages/billing-core)。

## Vercel 部署
在 Vercel 项目设置里把 **Root Directory** 设为 `apps/billing-report`。
构建产物为 `dist/`（`vercel.json` 已声明 buildCommand / outputDirectory）。
