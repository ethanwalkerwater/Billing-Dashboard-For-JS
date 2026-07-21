# @jingshi/billing-core

课时账单和老师收入的共享计算内核，是课时、取消、金额、提成和薪资公式的唯一真源。

## 模块

- `src/report-core.js`：CSV 解析、课时标准化、取消规则、学生/老师月度汇总。
- `src/payroll-core.js`：主数据解析、反馈系数、学员提成、个人收入和公司成本。

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
