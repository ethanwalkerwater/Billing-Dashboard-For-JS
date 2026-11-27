# @jingshi/billing-core

课时账单和老师收入的共享计算内核，是课时、取消、金额、提成和薪资公式的唯一真源。

## 模块

- `src/report-core.js`：CSV 解析、课时标准化、取消规则、学生/老师月度汇总。
- `src/payroll-core.js`：主数据解析、反馈系数、学员提成、个人收入和公司成本。

## 已离职老师

`report-core.js` 的 `DEPARTED_TEACHER_HASHES` 是离职老师名单。课表里他们的课保留作财务记录：课时账单、家长报告的学生账单显示成「已离职老师」，老师收入不出他的工资行，薪资预警同步时丢掉他的课。仓库公开，名单只存姓名的 FNV-1a 哈希，不写原名，只能防直接搜到。新增一位离职老师：

1. 用 `node -e 'import("@jingshi/billing-core").then(m=>console.log(m.teacherNameHash("姓名")))'` 算出哈希，加进 `DEPARTED_TEACHER_HASHES`。
2. 把同一个哈希加进 `apps/billing-report/python/course_billing_report.py` 的 `DEPARTED_TEACHER_HASHES`。
3. 合并到 main，课时账单和老师收入会自动部署。薪资预警要单独 `deploy:functions`，然后重新同步受影响的月份。

`billing-report` 和 `teacher-income-report` 构建时会把这些文件同步到各自的静态站点，不应在 app 中复制或手改计算实现。

## 测试

```bash
npm run test:core
npm run test:billing-report
npm run test:teacher-income-report
npm run build:billing-report
npm run build:teacher-income-report
```

修改计费或薪资规则时，上述测试和构建必须同时通过。薪资公式的业务说明见 [`apps/teacher-income-report/docs/business-rules.md`](../../apps/teacher-income-report/docs/business-rules.md)。
