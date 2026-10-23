# 教师薪资预警（teacher-income-alert）

从「课程表管理」飞书多维表格汇总每位老师当月课时费，按最低 / 最高系数（默认 0.47 / 0.62）预测薪资，和**预警线**比较。
预警线 = 基础薪水 × 底薪倍数（默认 1.2，和「老师收入详情」的底薪扣减系数一致，页面顶部可改）− 额外收入：

- **预警**：课时费 × 最高系数 < 预警线（老师还有余力）
- **区间内**：预警线落在两个预测值之间
- **已达标**：课时费 × 最低系数 > 预警线（已完成利润目标）
- **无底薪**：课表里有课但还没填基础薪水（兼职老师）

访问：<https://jingshi.vercel.app/teacher_income_tracking>（308 → CloudBase 静态托管 `/income/`）。飞书账号登录，和反馈追踪共用登录端点（`feedback-api` 的 `/auth/feishu/*`）与白名单表 `feedback_admins`，配置见 [反馈追踪 README](../course-feedback-tracker/README.md#飞书登录)。

## 口径

| 项 | 计算 |
|---|---|
| 课时费 | 当月「上课时间」落在该月（上海时区）的记录，「课程总价格」求和。该公式列已含请假折扣（如 6h-30% → 30%） |
| 计费课 | 只算有「课程单价」且「课程时长」> 0 的记录；老师日历里的会议 / 自习 / 备课占位没单价，不算课、不算学生 |
| 预测最低 / 最高 | 课时费 × 最低系数 / 最高系数 |
| 额外收入 | 课时以外的固定收入（如管理费），按老师手填；和收入详情一样进 Bonus 抵扣底薪 |
| 预警线 | 基础薪水 × 底薪倍数（默认 1.2）− 额外收入；页面在基础薪水下方灰字显示 |
| 距脱离预警 | 预测最高 − 预警线。正数已越过预警线，负数还差 |
| 距达标 | 预测最低 − 预警线。正数已达标，负数还差 |
| 课程单价 | 手填优先；没填用当月均价（课时费 ÷ 小时数），表里灰字 |
| 脱离预警需加 | \|距脱离预警\| ÷ (单价 × 最高系数)，向上取 0.1h；已越线为 0 |
| 达标需加 | \|距达标\| ÷ (单价 × 最低系数)；已达标为 0 |
| 自定义系数 | 按老师手填，试算 0.47 / 0.62 以外的系数；不填则下两列为空 |
| 自定义差值 | 课时费 × 自定义系数 − 预警线 |
| 自定义需加 | \|自定义差值\| ÷ (单价 × 自定义系数)；已越线为 0 |

「本月」是自然月，含月内尚未上的排课——这正是预警的意义：月中就能看到月底的预期。

## 结构

```text
src/domain/income.ts        全部计算（纯函数，前后端共用）
src/web/                    Workbench（单表）、EditableCell（点进去就能改）、useIncomeData
functions/income-api/       云函数：按月查课表（search 接口）+ 学生名对照 → aggregateSchedule → 写 income_teacher_months
migrations/                 income_teacher_months / income_teachers / income_settings + RLS；基础薪水种子
tests/income.test.ts        字段解析、当月汇总、三种状态与课时数
```

数据表（CloudBase PostgreSQL，同反馈追踪系统的库）：

- `income_teacher_months (month, teacher)`：同步结果，每次同步先删该月再写
- `income_teachers (teacher)`：基础薪水、额外收入、课程单价、自定义系数、备注、是否排除——页面里直接改
- `income_settings (id=1)`：最低 / 最高系数、底薪倍数

基础薪水：2026-10-08 起对齐「老师收入详情」的老师基础薪水表（`apps/teacher-income-report/web/assets/payroll/defaults.json`，
见 `migrations/202610080001_exclude_and_align_base_salaries.sql`）。之前 2026-09 那批种子恰好都是这张表的 1.2 倍（20000→24000），
应是把收入详情的「底薪扣减系数 1.2」乘了进去。现在基础薪水存原值，1.2 作为「底薪倍数」在计算预警线时乘
（`202610080002_alert_line_multiplier.sql`）；不在收入详情表里但同样被乘过的 Jack Hou、唐择运、马怡婷、高志勇也还原成 20000。
后续以页面手填为准；收入详情那边改了底薪，这里不会自动跟着变（那边的修改只存在各自浏览器的 localStorage 里）。

**排除老师**：鼠标移到老师名字上点 👁 图标即可排除（兼职、已离职、不需要盯的）。被排除的老师不进统计卡、不导出，表格默认不显示；
点「已排除 N 位」会把它们列在表格最上面，可以恢复。之前为了不算某位老师手动把底薪改成 0 的 7 位，已改为排除并填回正确底薪。每列表头悬停有口径说明；表头下滑时吸顶。

## 命令

```bash
npm test -w @jingshi/teacher-income-alert
npm run dev -w @jingshi/teacher-income-alert            # http://localhost:4177/income/
npm run deploy:functions -w @jingshi/teacher-income-alert   # 需要 server.env（见 server.env.example）
npm run deploy:web -w @jingshi/teacher-income-alert         # tcb hosting deploy dist /income
```

数据库迁移：`tcb db execute -e jingshi-test-d5gp401i44a0fa7a7 --sql "$(cat migrations/xxx.sql)"`。

## 已知限制

- 同步用飞书「查询记录」接口（`POST /records/search`）按「上课时间」过滤当月、只取 6 列：约 1500 行、3 页，本地实测 6–9 秒。
  以前用 list 接口全量拉整张表全部列，2026-10 时已 9800+ 行，本地实测 105–150 秒，且随课表增长越来越接近超时（云函数 300 秒、前端 240 秒）。
  - 日期条件 `ExactDate` 只精确到天，前后各放宽一天取超集，精确的月份边界仍由 `aggregateSchedule` 判断。
  - search 接口的形状和 list 不同：公式列是 `{type, value:[…]}`，学生关联只有 `link_record_ids`，名字用学生表
    （`FEISHU_STUDENT_TABLE_ID`，约 220 行 1 页）的主列「学生+联系方式」对照。`tests/income.test.ts` 锁住了两种形状。
  - 已与旧全量结果逐位对比 2026-08 至 11 四个月：课时费、课数、小时、学生完全一致；唯一差别是 list 接口把公式值
    截到 15 位有效数字，个别老师的自动均价恰好在 .5 上时差 1 元，search 接口给的是精确值。
- 同一节课多个学生（刷题班）的「课程总价格」按记录计入，不按学生拆分。
- 额外收入和自定义系数按老师存，不分月份；某月额外收入变了直接改那一格。
