# 数据目录与接口约定

`data/local/` 是仓库内所有真实输入的唯一落点，`outputs/` 是所有本地生成结果的唯一落点。两者都已被 Git 和 Vercel 排除。

不要重新创建 `data/raw/`、`data/private/`、`data/payroll/` 或 `data/完整课时费/` 等旧目录，也不要把学员、反馈、薪资数据复制到 `apps/`、`packages/` 或 `public/`。

## 标准结构

```text
data/
├── README.md
└── local/                                  # 真实输入，不提交、不部署
    ├── shared/
    │   └── schedule.csv                    # 公共课表
    ├── teacher-feedback/
    │   └── feedback.csv                    # 月度反馈总表
    ├── teacher-income/
    │   ├── defaults.json                   # 可选的本地薪资主数据
    │   └── monthly/
    │       ├── teacher-scores.csv           # 当月老师评分
    │       ├── reimbursements.csv           # 月度报销
    │       └── tax-and-social-insurance.csv # 五险与个税
    └── parent-report/
        └── complete-billing/                # 完整课时费 CSV，可放多份
```

目录可以提前建好，但其中真实文件不得提交。可以用下列命令确认：

```bash
git check-ignore data/local/shared/schedule.csv
git check-ignore data/local/teacher-income/defaults.json
```

## App 数据契约

| App | 输入 | 读取方式 | 输出 |
|---|---|---|---|
| `billing-report` | `local/shared/schedule.csv` | 网页手动上传；Python CLI 默认读取 | `outputs/course_billing_report/` |
| `teacher-income-report` | 课表/完整课时费、当月评分、五险个税、报销 | 网页手动上传 | 浏览器下载 XLSX |
| `teacher-feedback` | `local/shared/schedule.csv` + `local/teacher-feedback/feedback.csv` | 网页手动上传；Python CLI 默认读取 | `outputs/teacher-feedback/<YYYY-MM>/` |
| `parent-report` | 公共课表 + `local/parent-report/complete-billing/*.csv` | Node CLI 默认读取 | `outputs/parent_reports/` |

详细字段和操作步骤由各 app 的 README 维护：

- [课时账单](../apps/billing-report/README.md)
- [老师收入](../apps/teacher-income-report/README.md)
- [老师反馈](../apps/teacher-feedback/README.md)
- [家长报告](../apps/parent-report/README.md)

## 公共课表字段

`schedule.csv` 至少应包含：

```text
学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消
```

时间使用 `YYYY/MM/DD HH:mm` 或 `YYYY-MM-DD HH:mm`。当 `课程总价格` 缺失时，计费内核才会按单价、时长和取消比例回退计算。

## 老师收入本地默认值

`data/local/teacher-income/defaults.json` 是可选文件，用于本地构建时预填主数据。顶层结构为：

```json
{
  "baseSalaries": [],
  "studentOwnership": [],
  "parameters": {},
  "nameAliases": {}
}
```

该文件是本地维护源，不直接进 Git。经业务方确认可公开的默认值可同步到
`apps/teacher-income-report/web/assets/payroll/defaults.json` 并随网页部署；浏览器编辑后的版本
保存在 `localStorage`。老师评分不属于默认主数据，必须按月上传并按月份保存在浏览器中。
Vercel 云端构建不读取 `data/local/`。

## 本地操作

```bash
npm run dev:billing-report
npm run dev:teacher-income-report
npm run dev:teacher-feedback

npm run generate:billing-report
python3 apps/teacher-feedback/scripts/monthly_teacher_feedback.py --month 2026-06
npm run generate:parent-reports
```

如需临时替换输入，使用 CLI 的 `--input`、`--schedule`、`--feedback` 参数，或使用 `JINGSHI_SCHEDULE_PATH`、`JINGSHI_FEEDBACK_PATH`、`JINGSHI_PAYROLL_DEFAULTS_PATH` 环境变量，不需要移动默认文件。
