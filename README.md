# 菁仕教育服务

菁仕教育内部服务统一仓库。每个线上模块独立开发和部署，课时账单与老师收入共享同一套计算内核。

## 服务地图

| 目录 | 服务 | 线上地址 | 技术 |
|---|---|---|---|
| `apps/billing-report/` | 课时账单 | https://jingshi-course-billing.vercel.app/ | 静态 HTML/CSS/JS |
| `apps/teacher-income-report/` | 老师收入计算 | https://jingshi-teacher-income.vercel.app/ | 静态 HTML/CSS/JS |
| `apps/teacher-feedback/` | 老师反馈系统 | https://jingshi-feedback-service.vercel.app/ | FastAPI/Python |
| `apps/parent-report/` | 家长报告 | 本地生成，不部署 | Node.js/PDF |
| `packages/billing-core/` | 共享课时与薪资内核 | 不独立部署 | JavaScript |

统一入口：https://jingshi.vercel.app/

## 目录结构

```text
.
├── apps/                         # 可独立运行、测试、部署的应用
│   ├── billing-report/
│   ├── teacher-income-report/
│   ├── teacher-feedback/
│   └── parent-report/
├── packages/
│   └── billing-core/             # 账单与收入唯一计算真源
├── data/
│   ├── README.md                 # 数据用途、放置路径和测试说明
│   └── local/                    # 所有本地真实输入，不入 Git/Vercel
├── outputs/                      # 所有生成结果，不入 Git
├── package.json                  # npm workspaces 和统一命令
└── turbo.json                    # Monorepo 构建依赖
```

## 初始化

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r apps/teacher-feedback/requirements.txt
```

## 开发

```bash
npm run dev:billing-report        # http://localhost:4173
npm run dev:teacher-income-report # http://localhost:4174
npm run dev:teacher-feedback      # http://localhost:4175
```

所有本地真实数据统一放在 `data/local/`。完整说明见 [`data/README.md`](data/README.md)，最常用的输入是：

```text
data/local/shared/schedule.csv
data/local/teacher-feedback/feedback.csv
data/local/teacher-income/
data/local/parent-report/complete-billing/
```

网页模块不会自动读取电脑文件夹；启动本地网页后，按 `data/README.md` 的表格选择对应文件上传。命令行脚本才会自动读取上述默认路径。

## 测试与构建

```bash
npm test
npm run build:billing-report
npm run build:teacher-income-report
npm run build:teacher-feedback
```

`npm test` 会运行共享内核、家长报告和老师反馈测试。依赖旧版 Ivy 私有样本具体数值的视觉验收测试默认跳过，避免每次更换业务课表就误报；其余测试必须通过。

## 数据流

```text
课表 CSV ──> packages/billing-core ──> 课时账单
                         └───────────> 老师收入

反馈 CSV + 课表 CSV ──> 老师反馈 ──> outputs/teacher-feedback/<月份>/
                                      └─> 家长报告老师评分汇总
```

`apps/parent-report/scripts/build-teacher-score-averages.mjs` 默认读取
`outputs/teacher-feedback/`，不包含个人电脑绝对路径。

## Vercel

同一个 GitHub 仓库连接三个 Vercel Project：

| Project | Root Directory | Output |
|---|---|---|
| `jingshi-course-billing` | `apps/billing-report` | `dist` |
| `jingshi-teacher-income` | `apps/teacher-income-report` | `dist` |
| `jingshi-feedback-service` | `apps/teacher-feedback` | `public` + Python Functions |

生产分支为 `main`。功能分支生成 Preview，合并到 `main` 后更新生产域名。Vercel 的 Skip Unaffected Projects 应保持开启，使无关服务不重复构建。

## 隐私规则

- 真实课表、学员反馈、工资、报销、生成报告都不能提交。
- `.vercel/`、`.venv/`、`outputs/`、`data/local/` 均已忽略。
- 只提交匿名化测试样本、源代码和不含个人数据的模板。
- 部署前使用 `git status` 和 `git check-ignore` 再次确认原始数据未进入暂存区。
