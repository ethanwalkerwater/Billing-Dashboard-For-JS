# 教师薪资预警（teacher-income-alert）

从「课程表管理」飞书多维表格汇总每位老师当月课时费，按最低 / 最高系数（默认 0.47 / 0.62）预测薪资，和基础薪水比较：

- **预警**：课时费 × 最高系数 < 基础薪水（老师还有余力）
- **区间内**：基础薪水落在两个预测值之间
- **已达标**：课时费 × 最低系数 > 基础薪水（已完成利润目标）
- **无底薪**：课表里有课但还没填基础薪水（兼职老师）

访问：<https://jingshi.vercel.app/teacher_income_tracking>（308 → CloudBase 静态托管 `/income/`）。登录账号与反馈追踪系统共用（`jsjy`，白名单表 `feedback_admins`）。

## 口径

| 项 | 计算 |
|---|---|
| 课时费 | 当月「上课时间」落在该月（上海时区）的记录，「课程总价格」求和。该公式列已含请假折扣（如 6h-30% → 30%） |
| 计费课 | 只算有「课程单价」且「课程时长」> 0 的记录；老师日历里的会议 / 自习 / 备课占位没单价，不算课、不算学生 |
| 预测最低 / 最高 | 课时费 × 最低系数 / 最高系数 |
| 距脱离预警 | 预测最高 − 基础薪水。正数已越过预警线，负数还差 |
| 距达标 | 预测最低 − 基础薪水。正数已达标，负数还差 |
| 课程单价 | 手填优先；没填用当月均价（课时费 ÷ 小时数），表里灰字 |
| 脱离预警需加 | \|距脱离预警\| ÷ (单价 × 最高系数)，向上取 0.1h；已越线为 0 |
| 达标需加 | \|距达标\| ÷ (单价 × 最低系数)；已达标为 0 |

「本月」是自然月，含月内尚未上的排课——这正是预警的意义：月中就能看到月底的预期。

## 结构

```text
src/domain/income.ts        全部计算（纯函数，前后端共用）
src/web/                    Workbench（单表）、EditableCell（点进去就能改）、useIncomeData
functions/income-api/       云函数：拉课表 → aggregateSchedule → 写 income_teacher_months
migrations/                 income_teacher_months / income_teachers / income_settings + RLS；基础薪水种子
tests/income.test.ts        字段解析、当月汇总、三种状态与课时数
```

数据表（CloudBase PostgreSQL，同反馈追踪系统的库）：

- `income_teacher_months (month, teacher)`：同步结果，每次同步先删该月再写
- `income_teachers (teacher)`：基础薪水、课程单价、备注——页面里直接改
- `income_settings (id=1)`：最低 / 最高系数

基础薪水初始值见 `migrations/202609180003_base_salaries_2026_09.sql`（教务 2026-09 给出的 22 位老师），后续以页面手填为准。每列表头悬停有口径说明；表头下滑时吸顶。

## 命令

```bash
npm test -w @jingshi/teacher-income-alert
npm run dev -w @jingshi/teacher-income-alert            # http://localhost:4177/income/
npm run deploy:functions -w @jingshi/teacher-income-alert   # 需要 server.env（见 server.env.example）
npm run deploy:web -w @jingshi/teacher-income-alert         # tcb hosting deploy dist /income
```

数据库迁移：`tcb db execute -e jingshi-test-d5gp401i44a0fa7a7 --sql "$(cat migrations/xxx.sql)"`。

## 已知限制

- 飞书「上课时间」不支持服务端按日期过滤，每次同步全量拉约 8700 行，约 70 秒；前端 SDK 超时已调到 240 秒。
- 同一节课多个学生（刷题班）的「课程总价格」按记录计入，不按学生拆分。
- 只有一份全局系数；若不同老师系数不同，给 `income_teachers` 加两列即可。
