# 老师收入报表（teacher-income-report）

本 app 是课时账单的下游：读取课时费、五险个税、报销和主数据，按月生成老师个人收入与公司总成本。页面为纯静态应用，上传的 CSV 只在当前浏览器中处理。

## 结构

```text
web/                 页面源码
  index.html
  assets/app.js
  assets/styles.css
scripts/             共享内核同步、构建与校验
docs/business-rules.md
vercel.json
```

课时和薪资计算不在页面内重复实现，唯一真源为 [`packages/billing-core`](../../packages/billing-core/README.md)。

## 本地命令

在仓库根目录执行：

```bash
npm run dev:teacher-income-report    # http://localhost:4174
npm run test:teacher-income-report
npm run build:teacher-income-report
```

## 每月输入

| 页面入口 | 必要字段 | 说明 |
|---|---|---|
| 课时费 CSV | 公共课表字段，或 `月份,老师,学生,总时长（h）,实际金额（¥）` | 必填，提供月度课时费 |
| 五险 + 个税 CSV | `姓名,个税,个人五险,公司五险` | 缺失时页面给出数据提醒 |
| 补贴报销 CSV | `老师名字,报销金额` | 可选，未上传按 0 处理 |
| 当月老师评分 CSV | `老师,学习提升效果,责任心与服务态度,个人魅力` | 每个月独立上传，只用于所选月份的前 50% 排名 |

页面的“下载模板”按钮可以直接生成正确表头。课时明细支持折扣百分比和数值乘数，
老师实际课时费为 `总金额 × 折扣% × 乘数`；乘数不会改变学生归属和服务提成的计提基数。
Bonus 公式结果为负时仍保留在明细中提示课时不足，但个人收入和公司成本均按 `0` 计入。
全部数据路径约定见 [`data/README.md`](../../data/README.md)。

## 主数据

页面内可编辑并可通过 CSV 整表导入：

- 老师基础薪水和雇佣属性
- 学生归属老师与服务老师
- 当月老师评分（按月份隔离保存、按三项均分排序，并标出每项前 50%）
- 课时系数、提成和底薪扣减参数

项目公开默认值随网页部署在 `web/assets/payroll/defaults.json`。需要用本地
`data/local/teacher-income/defaults.json` 更新公开默认值时，显式设置
`JINGSHI_PAYROLL_DEFAULTS_PATH` 后运行 `npm run sync-core -w @jingshi/teacher-income-report`；
更新后应确认内容可公开并提交该文件。用户在网页导入或编辑某个主数据板块后，该板块会保存到
当前浏览器的 `localStorage`，刷新页面不会丢失，并优先于项目默认值加载。老师评分不随项目
默认值部署，必须按工资月份上传；每个月的评分会按月份单独保存在当前浏览器中。

## 操作流程

1. 启动页面，上传课时费 CSV。
2. 上传当月五险个税、报销和老师评分 CSV。
3. 检查基础薪水、学员归属、当月评分排名和薪资参数。
4. 选择月份和老师，复核课时、Bonus、扣减和数据提醒。
5. 导出当前老师或当月全部汇总 `.xlsx`。本月汇总的第一个 Sheet 是汇总表，后续每位老师一个工资明细 Sheet。

计算公式和异常数据处理见 [薪资业务规则](docs/business-rules.md)。

## Vercel

Vercel Project 的 Root Directory 为 `apps/teacher-income-report`，构建产物为 `dist/`。
云端使用已提交的公开默认值，不读取仓库外的 `data/local/`。
