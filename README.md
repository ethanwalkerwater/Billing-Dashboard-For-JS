# 菁仕收费 Monorepo

一个仓库，两个项目，共享同一套课时收费计算内核。

```
菁仕收费2/
├─ packages/
│  └─ billing-core/        ★ 共享计算内核（唯一真源）
│                            从 CSV 计算每个学生/老师的收费与收入
├─ apps/
│  ├─ billing-report/      【项目1】课时收费报表（上游）
│  │                         上传 CSV → 交互式收费报表（网页版 + Python 版）
│  └─ parent-report/       【项目2】家长报告（下游）
│                            基于学生收费计算 → 每位家长的 PPT/PDF
├─ data/raw/              共享输入：schedule.csv（不入库）
└─ outputs/              共享产物目录（不入库）
   ├─ course_billing_report/   ← 项目1
   ├─ parent_reports/          ← 项目2
   └─ parent_reports_web/      ← 项目2
```

## 怎么分清哪个文件属于哪个项目

看路径前缀即可，无需记忆：

| 前缀 | 归属 | 说明 |
|------|------|------|
| `packages/billing-core/` | 共享内核 | 两个项目都 import 它，改这里两边同时生效 |
| `apps/billing-report/` | 项目1 | 收费报表（网页 + Python） |
| `apps/parent-report/` | 项目2 | 家长报告生成与导出 |
| `data/`、`outputs/` | 共享 I/O | 输入 CSV 与各项目产物（按子目录区分） |

## 上下游关系

```
data/raw/schedule.csv
        │
        ▼
packages/billing-core  ──► apps/billing-report   （项目1：报表）
        │
        └──────────────►  apps/parent-report     （项目2：家长报告依赖费用计算）
```

项目2 通过 `import { buildReportFromCsv } from "@jingshi/billing-core"` 拿到费用计算，
不重复实现计算逻辑。npm workspaces 把 `@jingshi/billing-core` 软链接到本地包，改内核无需发版。

## 常用命令（都在仓库根运行）

```bash
npm install                                    # 安装并建立 workspace 软链接

# 项目1 课时收费报表
npm run dev   -w @jingshi/billing-report       # 本地静态站 http://localhost:4173
npm run build -w @jingshi/billing-report       # 生成 dist/ 并校验
npm run test:python -w @jingshi/billing-report # Python 版测试

# 项目2 家长报告
npm run generate   -w @jingshi/parent-report   # 生成报告 HTML
npm run export:pdf -w @jingshi/parent-report   # 导出 PDF

# 测试
npm test                                       # 内核 + 项目2 的 node 测试
npm run test:billing-report                    # 项目1 静态站校验
```

各项目细节见各自 README：
[项目1](apps/billing-report/README.md) · [项目2](apps/parent-report/README.md) · [共享内核](packages/billing-core/)

## 部署（项目1 → Vercel）

在 Vercel 项目设置里把 **Root Directory** 设为 `apps/billing-report`。
构建命令与产物目录已在 `apps/billing-report/vercel.json` 声明（`npm run build` → `dist/`）。
线上页面不保存原始课表，CSV 在浏览器本地解析。

## 报表口径（项目1）

- 学生收费视图：按月份和学生筛选，展示当月上过哪些老师的课。
- 老师收入视图：按月份和老师筛选，展示当月教过哪些学生。
- 汇总维度：对方、课程类型、授课类型、取消/上课状态；同课程类型不同授课类型拆行。
- 临时取消按 `0h-70%`、`2h-50%`、`6h-30%` 单独列出并计费。
- 金额优先用原始表 `课程总价格`，同时计算规则金额用于校验异常。
