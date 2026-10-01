# 雅思正向率（ielts-progress）

老师在飞书表单录入学生的雅思基线和实考成绩，教务核验实考后，系统按课表找出每科的授课老师，算出每位老师的学生正向率（本次实考比上一次成绩高）。

- 登录与反馈追踪、薪资预警共用（`jsjy`，白名单表 `feedback_admins`）。
- 静态站点：CloudBase 托管 `/ielts/`；门户短链接 `jingshi.vercel.app/ielts` 在 `菁仕后台主页` 仓库里配 308。
- 设计与口径：[`specs/ielts-progress/design.md`](../../specs/ielts-progress/design.md)。

## 飞书

| 用途 | 地址 |
|---|---|
| 老师录入表单（发给老师） | <https://ccntnl19k0y3.feishu.cn/share/base/shrcnKvQvKlOwLxuOOz6KOTmrmK> |
| 「雅思成绩」表（教务核验、改错） | 课程表管理多维表格里的 `雅思成绩`（`tblbeqyLAlDVAGYJ`） |

表结构：学生（关联学员信息）· 成绩类型（基线/实考）· 考试日期 · 听力/阅读/写作/口语（单选 0–9，步长 0.5）· 成绩单（附件）· 已核验（仅教务）· 提交人 · 备注。
**字段不要改名**：同步前会检查字段表，缺字段直接报错并保留旧数据。

日常流程：老师提交 → 教务打开成绩单核对分数，勾「已核验」→ 页面点「同步」（每天 07:00 也会自动同步）。没计入的记录都在页面顶部「待处理」里，点开能跳回飞书那一行。

## 口径

| 项 | 规则 |
|---|---|
| 样本 | 每次已核验实考的每一科，和该学生上一次该科有分的成绩（基线或更早的已核验实考）比 |
| 结果 | 提分 = 正向；持平、下降分开统计 |
| 授课老师 | 课表中该学生、该科目，`上一次成绩日期 ≤ 上课日期 < 本次考试日期`，非临时取消 |
| 科目 | `雅思` = 四科全算；`雅思写作` / `雅思提高班-写作` 等按名字里的科目；刷题、试听、考试、模考不算 |
| 多位老师 | 每人各算一次；整体统计按样本去重 |
| 小样本 | 老师样本 < 5 灰显、不排名 |

## 结构

```text
src/domain/progress.ts     全部规则（纯函数，前后端共用）
functions/ielts-api/       云函数：读「雅思成绩」+ 课表雅思课（服务端过滤，约 1700 行 / 15 秒）→ 写一行快照
migrations/                ielts_snapshots（feishu / legacy 两行 JSON）+ RLS
scripts/import-legacy.ts   历史 CSV 一次性导入
src/web/                   看板
```

数据库只存原始数据快照，配对和统计在浏览器里现算：同步一次是一次 upsert（原子替换），打开页面只发一个查询。

## 命令

```bash
npm test -w @jingshi/ielts-progress
npm run dev -w @jingshi/ielts-progress                 # http://localhost:4178/ielts/
npm run deploy:functions -w @jingshi/ielts-progress    # 需要 server.env（见 server.env.example）
npm run deploy:web -w @jingshi/ielts-progress
npm run import:legacy -w @jingshi/ielts-progress -- ../../data/local/ielts-progress/teacher_score_records_xxx.csv
```

数据库迁移：`tcb db execute -e jingshi-test-d5gp401i44a0fa7a7 --sql "$(cat migrations/xxx.sql)"`。

## 历史数据

旧系统导出的 `teacher_score_records_*.csv` 是「学生 × 科目 × 老师」展开后的配对结果，没有基线日期。导入时按（学生, 科目, 基线, 实考）合并成一条样本，日期取最早录入日；老师名对照课表「老师」选项（`Kevin → Kevin Liu`、`Valentina 林 → Valentina Lin`），对不上直接失败。2026-10-01 试算：119 行 → 101 条样本，整体正向率 71%。
