# 本地数据说明

`data/local/` 是所有真实输入数据的唯一存放位置，已被 Git 和 Vercel 忽略。`outputs/` 只存放生成结果。不要把真实学员、反馈或薪资数据放进 `apps/`、`packages/` 或 `public/`。

## 文件放置位置

```text
data/
├── README.md
└── local/                              # 不提交、不部署
    ├── shared/
    │   └── schedule.csv                # 公共课表
    ├── teacher-feedback/
    │   └── feedback.csv                # 月度反馈总表
    ├── teacher-income/
    │   ├── defaults.json               # 本地薪资默认配置
    │   └── monthly/
    │       ├── reimbursements.csv       # 月度报销
    │       └── tax-and-social-insurance.csv
    └── parent-report/
        └── complete-billing/            # 完整课时费 CSV，可放多份
```

## 哪个模块读取什么

| 模块 | 默认读取 | 使用方式 | 输出 |
|---|---|---|---|
| 课时账单 `billing-report` | `local/shared/schedule.csv` | 网页手动上传；Python 本地生成命令会自动读取 | `outputs/course_billing_report/` |
| 老师收入 `teacher-income-report` | 构建时读取 `local/teacher-income/defaults.json` | 课表、报销、五险个税在网页中手动上传 | 浏览器下载，不写本地目录 |
| 老师反馈 `teacher-feedback` | `local/shared/schedule.csv` + `local/teacher-feedback/feedback.csv` | 网页手动上传；Python 命令行会自动读取 | `outputs/teacher-feedback/<月份>/` |
| 家长报告 `parent-report` | 公共课表 + `local/parent-report/complete-billing/*.csv` | 生成命令自动读取 | `outputs/parent_reports/` |

浏览器出于安全限制，不能自行读取电脑文件夹。因此三个网页上传页面都需要你主动选择文件；“默认读取”只适用于本地命令行和构建脚本。

## 本地测试示例

在仓库根目录运行：

```bash
# 课时账单网页：启动后上传 data/local/shared/schedule.csv
npm run dev:billing-report

# 老师收入网页：启动后上传公共课表及 teacher-income/monthly 下的月度文件
npm run dev:teacher-income-report

# 老师反馈网页：启动后上传公共课表和 feedback.csv
npm run dev:teacher-feedback

# 课时账单命令行：自动使用公共课表
npm run generate:billing-report

# 老师反馈命令行：自动使用公共课表和 feedback.csv
python3 apps/teacher-feedback/scripts/monthly_teacher_feedback.py --month 2026-06

# 家长报告：自动读取 complete-billing 目录和公共课表
npm run generate:parent-reports
```

如需临时使用其他文件，可以使用各命令的 `--input`、`--schedule`、`--feedback` 等参数，不需要移动或覆盖默认数据。
