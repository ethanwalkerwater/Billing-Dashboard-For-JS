# 老师收入报表（teacher-income-report）

本 app 是课时账单的下游：读取课时费、五险个税、报销和本地主数据，按月生成老师个人收入与公司总成本。页面为纯静态应用，上传的 CSV 只在当前浏览器中处理。

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

页面的“下载模板”按钮可以直接生成正确表头。全部数据路径约定见 [`data/README.md`](../../data/README.md)。

## 主数据

页面内可编辑：

- 老师基础薪水和雇佣属性
- 学生归属老师与服务老师
- 老师反馈评分
- 课时系数、提成和底薪扣减参数

本地可选默认值放在 `data/local/teacher-income/defaults.json`。该文件不提交、不部署。不存在时页面使用空主数据和内置薪资参数启动。

## 操作流程

1. 启动页面，上传课时费 CSV。
2. 上传当月五险个税和报销 CSV。
3. 检查基础薪水、学员归属、反馈评分和薪资参数。
4. 选择月份和老师，复核课时、Bonus、扣减和数据提醒。
5. 导出单位老师明细或当月全部汇总。

计算公式和异常数据处理见 [薪资业务规则](docs/business-rules.md)。

## Vercel

Vercel Project 的 Root Directory 为 `apps/teacher-income-report`，构建产物为 `dist/`。云端构建不得读取真实 `data/local/` 或配置指向薪资文件的 `JINGSHI_PAYROLL_DEFAULTS_PATH`。
