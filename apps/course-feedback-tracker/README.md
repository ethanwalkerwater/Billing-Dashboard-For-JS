# 月度课程反馈问卷跟踪系统

面向教务老师的 CloudBase 应用。选择课程月份后，系统读取这个月的飞书课表（月中也行，按已排的课），按「课程月份 + 学生 + 老师」生成一份问卷任务，跟踪未发、已发未填、已填写、拒绝填写四种状态，并导出可直接喂给现有老师反馈报表系统的 CSV。

- 工作台：<https://app.jsjy.asia/feedback/>（自有域名，静态托管的 `/feedback/` 子目录，和雅思正向率 `/ielts/`、教师薪资预警 `/income/` 并列）。
  根目录 `/` 是跳转页（`root-redirect/index.html`），旧链接、默认域名根目录、收藏的 `#/scores` 会原样带过来
- 教务可在[感谢礼管理](https://app.jsjy.asia/feedback_thanks/)处理学生送给老师的礼物、修改金额和更换图片。团队成员使用本企业飞书账号登录即可。
- 工作台短链接：<https://jingshi.vercel.app/feedback>（Vercel 门户 307 跳转到上面的地址）
- 默认域名（仍可用）：<https://jingshi-test-d5gp401i44a0fa7a7-1300607705.tcloudbaseapp.com>
- 自有域名配置（2026-10）：腾讯云 SSL 免费证书（`app.jsjy.asia`，90 天，已开自动续费，到期 2027-01-06）；
  CloudBase「HTTP 访问服务」自定义域名 + 路由 `/` → 静态托管（`STATIC_STORE / staticstore`，控制台下拉选不到，用
  `tcb routes add` 加的）；DNSPod 记录 `app CNAME app.jsjy.asia.tcbaccess.tencentcloudbase.com`；安全域名已加 `app.jsjy.asia`。
  证书续期后若 CloudBase 没自动换上，到「静态网站托管 → 基础配置」重新选证书。主域名 `jsjy.asia` 是官网（另一台服务器），不要动。
- 门户入口：<https://jingshi.vercel.app/> 「学生反馈追踪系统」（源码在 `~/Documents/GitHub/菁仕后台主页`）
- 登录：飞书账号（反馈工作台、取消课程、雅思正向率、教师薪资预警共用，不再有账号密码登录）。白名单是 `feedback_admins` 表，按飞书 open_id 维护；
  所有学生/老师数据都靠 RLS 的管理员白名单保护，登录不能去掉。流程与配置见下方「飞书登录」。
- 旧版短链接（仍可用，仅供已印出去的码）：`https://jingshi-test-d5gp401i44a0fa7a7-1300607705.ap-shanghai.app.tcloudbase.com/t/<token>`
- 飞书事件回调：`https://jingshi-test-d5gp401i44a0fa7a7-1300607705.ap-shanghai.app.tcloudbase.com/webhooks/feishu`

## 架构

测试环境的 CloudBase 数据库是 PostgreSQL 17，因此采用「前端直连 + 单云函数」的形态，而不是 design.md 里最初设想的三函数 + 云存储方案：

| 部分 | 做法 |
|---|---|
| 任务列表、筛选、统计、改状态、任务清单导出 | 浏览器用 `@cloudbase/js-sdk` 的 `rdb()`（PostgREST）直连数据库，RLS 只放行 `feedback_admins` 里的管理员 |
| 飞书课表同步、答卷对账、扫码短链接 302、飞书事件回调、课表/反馈 CSV 导出、老师评分取数 | 云函数 `feedback-api`（Node） |
| 老师加权评分计算 | 云函数 `feedback-score`（Python 3.10，128MB），**纯计算、一次一个月**：直接复用 `apps/teacher-feedback/scripts` 的脚本（打包时复制），不读库、不碰密钥；只在数据变了时由 `feedback-api` 调用，结果存 `feedback_score_results` |
| 二维码单张 PNG 与批量 ZIP | 浏览器里用 canvas + JSZip 生成，不经过云存储。二维码指向学生月度反馈页；同一学生当月一张码 |
| 界面 | shadcn/ui 默认主题（zinc），Tailwind v4；组件按 shadcn 源码手写在 `src/components/ui/`（button/badge/card/input/checkbox/table/sheet/select/alert/separator） |
| 状态变更审计 | 数据库触发器 `feedback_tasks_status_audit`，前端和云函数都绕不过 |

云函数里 `app.rdb()` 实测拿到的是 `anon` 角色（和没登录的浏览器一样），读写业务表会 permission denied。所以函数自己拼 PostgREST 请求，用环境 API Key 鉴权，该 Key 的 JWT 里 `role=service_role`，可绕过 RLS。见 [`functions/feedback-api/service-db.ts`](./functions/feedback-api/service-db.ts)。

## 当前状态

已完成并在测试环境验证：

- 双月份口径、课表过滤与分组、稳定任务 ID、状态迁移、飞书预填 URL
- 飞书适配器：分页读取、限流重试、字段结构校验（只读，不写飞书）
- PostgreSQL 表结构、索引、RLS 策略、状态审计触发器（已应用到测试环境）
- 云函数 `feedback-api`：已部署，`/t/:token` 302 跳转和飞书 `url_verification` challenge 已实测通过
- 教务前端（V2 单表工作台）：一行一个学生-老师对，状态、谁评了（学生/家长）、学生二维码同屏可见；
  顶部横幅直接列出人员对不上的反馈并给出下一步；列可排序、三个筛选器、批量浮动栏、行抽屉
- 静态站点已部署

已用真实数据跑通（2026-09 收集月 / 2026-08 课程月）：

- 全量读取 8594 条课表，生成 **258 份任务、89 位学生、32 位老师**
- 排除 378 条（临时取消 / 非授课），待复核 61 条，课表数据有问题 55 条
- 真实二维码短链接扫开后 302 跳飞书问卷，老师、学生两项预填正确
- 教务账号可登录工作台，RLS 白名单双向验证通过

待办：

- 飞书事件订阅（开放平台后台，需要应用管理员）：
  1. 「事件与回调 → 加密策略」生成 Encrypt Key 和 Verification Token，写进 `server.env` 的
     `FEISHU_EVENT_ENCRYPT_KEY` / `FEISHU_EVENT_VERIFICATION_TOKEN`，`npm run deploy:functions`；
  2. 「事件配置」请求地址填 `https://jingshi-test-d5gp401i44a0fa7a7-1300607705.ap-shanghai.app.tcloudbase.com/webhooks/feishu`，
     添加事件「多维表格记录变更」`drive.file.bitable_record_changed_v1`，开通它要的权限并发版；
  3. `npx tsx scripts/setup-feishu.ts` 订阅答卷多维表格（脚本最后一步）。
  配好之前答卷靠每天凌晨 3 点的定时对账和工作台「刷新反馈」进库。

## 本地运行

```bash
npm install
npm run dev:course-feedback-tracker
```

浏览器打开 `http://localhost:4176/feedback/`（`vite.config.ts` 的 `base` 是 `/feedback/`）。

## 验证

```bash
npm run test:course-feedback-tracker   # 45 个 TS 测试 + 评分函数的 Python 测试
npm run build:course-feedback-tracker
```

## 部署

```bash
cd apps/course-feedback-tracker
npm run deploy:functions   # 打包 + 部署 feedback-api（读 server.env 注入环境变量）
tcb fn trigger create feedback-api -e jingshi-test-d5gp401i44a0fa7a7   # 只在首次或改了 cloudbaserc.json 的 triggers 时：每日 3 点定时对账
npx tsx scripts/setup-feishu.ts   # 幂等：答卷表加「反馈课程月份」字段并放进问卷、订阅记录变更事件
tcb db execute --sql "$(cat migrations/202610160003_owner_assignments.sql)"
npm run deploy:web         # 构建 + 部署到静态托管 /feedback/
npm run deploy:root-redirect   # 只在根目录跳转页改动时需要：覆盖根目录 index.html
```

数据库变更用 CLI 执行：

```bash
tcb db execute --sql "$(cat migrations/202609170001_initial_feedback_tracker.sql)"
tcb db execute --sql "$(cat migrations/202609170002_task_status_audit.sql)"
tcb db execute --sql "$(cat migrations/202609170003_response_unlinked_status.sql)"
tcb db execute --sql "$(cat migrations/202609170004_name_binding.sql)"
tcb db execute --sql "$(cat migrations/202610020001_excluded_teachers.sql)"
tcb db execute --sql "$(cat migrations/20261106_excluded_students.sql)"
tcb db execute --sql "$(cat migrations/202610050001_teacher_scores.sql)"
tcb db execute --sql "$(cat migrations/202610050002_score_results.sql)"
tcb db execute --sql "$(cat migrations/202610160002_feedback_month_owner.sql)"
tcb db execute --sql "$(cat migrations/202611110001_feedback_roles.sql)"
npx tsx scripts/backfill-teacher-scores.ts   # 一次性：历史分数 + 补算分项 + 各月结果入库（可重复执行，需本机 python3）
```

> 测试必须用 `npm run test:course-feedback-tracker` 跑（工作区脚本），不能在仓库根目录直接
> `npx tsx --test apps/.../tests/*.ts`——tsx 要在 app 目录下才认得 tsconfig 里的 `@/` 路径别名。

## 环境变量

- 前端：[.env.example](./.env.example)。只放可公开的值。
- 云函数：[server.env.example](./server.env.example)。复制成 `server.env`（已 gitignore），`npm run deploy:functions` 会把它注入函数环境变量。飞书 App Secret、`PUBLIC_TOKEN_PEPPER`、`CLOUDBASE_API_KEY` 都只经这条路进 CloudBase，不进 Git、不进前端构建产物。

`CLOUDBASE_API_KEY` 用 `tcb env apikey create <名称> --type api_key` 生成，只在创建时显示一次。

> 安全提醒：飞书 App Secret 曾在早期对话和旧云函数配置里出现过。上线前应在飞书开放平台轮换一次，把新值写进 `server.env` 后重新部署。

## 数据口径

- **每个课程月份一轮，各有各的二维码**（业务方 2026-10 定）。工作台按课程月份切换，默认本月；
  内部仍用收集月份（课程月份 + 1）当这一轮的键，任务 ID、表结构都没变。月底前就能「生成名单」、把码发出去，
  学生不用等到下个月 1 号。名单按课表里这个月已排的课生成，之后再点「生成名单」会跟上课表变化。
- **评价后课时定稿**：任务上存着生成名单时这几节课的课表行（`feedback_tasks.lessons`）。有人评价后，再生成名单不再改它的课程和课时，
  评分时这对学生-老师的权重按这几行算（`applyFrozenLessons`）；没人评的照常跟着课表走。
- 负责人（傅威程 / Tinko / 华心晨）：表格里单行下拉或批量设置，存成「从这个课程月份起生效」（`feedback_owner_assignments`），
  不存在任务上。每个月显示本月或之前最近一次设定（同一对学生-老师优先，换了老师用同一学生的），沿用的显示成灰色：
  9 月设了华心晨，10、11 月都是华心晨；10 月改成 Tinko，从 10 月起是 Tinko。名单先生成、后去改之前的月份也会跟着变。
- 答卷表的「反馈课程月份」已用 `scripts/backfill-feedback-month.ts` 给历史答卷补齐（提交月份的上一个月，和默认归属一致）。
- 带临时取消标记的课程不生成任务。
- 排除判断排在缺字段判断**前面**。真实课表里「请假」「模拟考试」「例会」这类记录本来就没有老师或学生，先查缺字段会把近 300 条/月误报成"课表数据有问题"。
- **只有「课程」生成问卷、计入老师课时和评分**，问卷名单和评分共用一个判断 `src/domain/lesson-kind.ts`（业务方 2026-10 定）：
  1. 「课程类型」页手动设过的以手动为准（表 `feedback_course_type_rules`）；
  2. 课程类型名含咨询/规划/考试/模考/会议/自习/作业/助教/答疑/文书/请假/团建等关键词 → 不是课程（1v1 的「申请咨询」也不算）；
  3. 授课类型为 1v1 / 刷题班 / 1v2班课 / 班课 → 课程；其他授课类型（学生规划、自习、作业、助教、模考…）→ 不是课程；
  4. 没填授课类型、名字也看不出来 → 先按课程处理，列进同步明细「未标注授课类型」和「课程类型」页「待复核」。
- 改了判断后「生成名单」会删掉不再是课程、也没人填过的任务；已经有人填过的保留，列在同步明细里。
- 同一学生与同一老师当月的多门课程合并到一份任务。
- 答卷归哪一轮看**「反馈课程月份」**：月度反馈页由服务端写入；旧二维码预填并隐藏（`prefill_反馈课程月份=2026-10&hide_反馈课程月份=1`，文本字段；
  表单设置里这道题必须是「显示」，预填才生效，靠链接参数藏起来；直接打开表单的人会看到它和「请勿修改」的说明）。
  这样 10 月 20 日提前交的 10 月反馈和同一天晚交的 9 月反馈各归各的，同一对学生-老师两轮也不会互相挤成「重复」。
  没有这一项的（老二维码、直接打开表单、被改成了别的写法）按**提交时间**（上海时区）：提交月份即收集月份，评的是上个月的课。
- 飞书反馈表只加了这一个字段（业务方 2026-10 同意），仍不用任务 ID。答卷只按（学生姓名, 老师姓名）在这一轮里匹配任务：
  NFKC 规范化、去空格、忽略大小写后精确相等，外加 `feedback_name_aliases` 别名表
  （`Valentina 林 → Valentina Lin`、`顾子言 → 顾子言Tina` 这类）。**不做模糊匹配**。
- 每个任务有学生位置和家长位置各一个（按问卷「身份」字段），任一位置有答卷即为「已填写」；
  同一身份的第二份标 `duplicate`。
- 对不上的答卷标 `unlinked`，在「对不上任务的答卷」里带原始姓名列出来，教务加别名或手动绑定
  （`feedback_responses.bound_by='manual'` + `task_id`，重新同步时保留）。
- 答卷由飞书原问卷写入答卷表。「生成名单」会把本月课表学生**追加**进问卷「学生姓名」下拉（只加不删，删单选选项会清空历史答卷的值）。
  姓名取学生表「学生姓名」，不是课表关联字段里的「姓名-手机尾号」。老师下拉缺的名字仍只提示，由教务手动加。
- 答卷怎么进库：飞书推「记录变更」事件 → 云函数读整张答卷表，对账受影响的那几轮并重算分数（幂等，飞书重推无妨）；
  每天凌晨 3 点定时对账还在收集的两轮（本月课程、上月课程）兜底；工作台「刷新反馈」手动补一次。**打开页面只读库**，不再去飞书拉。
- 飞书里删掉的答卷（或学生、老师都没填的空行）在下一次对账时从库里清掉，
  并腾出任务上的学生/家长位置；两个位置都空了的「已填写」退回「已发未填」。飞书整表读回 0 行时不清理，防误删。
- 「不统计的老师 / 学生」名单（`feedback_excluded_teachers`、`feedback_excluded_students`，所有月份通用）：任务照常生成和对账，只在工作台统计、表格、横幅里隐藏；不统计的学生也不进老师评分的覆盖率和加权课时。
- 2026-09 实测：182 份答卷 → 177 对上、4 重复、1 对不上，覆盖 176/258 个任务。
  唯一对不上的「杨呈悦Joy × 蓝浪」两个名字都在课表里，但 8 月没排过这对组合——加别名无用，
  顶部横幅会直接这么说，并提供手动绑定。

课表「上课时间」字段**不支持服务端日期筛选**（ExactDate 和时间戳都返回 1254018 InvalidFilter），所以同步是全表读取后在内存里按上海时区过滤。当前 8594 行，一次约 40 秒。

### 多维表格字段形状

`records` 接口返回的关联字段长这样，**没有** `id` 或 `record_id` 键：

```json
"学生": [{ "record_ids": ["recXXX"], "table_id": "tbl...", "text": "陈语墨-", "text_arr": ["陈语墨-"], "type": "text" }]
```

`lark-cli` 会把它归一化成 `[{ id }]`，两者不一样。只认 `id` 的话整月任务会全部判成「缺少学生」——实测 8 月会从 258 份任务掉到 0 份。`tests/feishu.test.ts` 用真实形状锁住了这一点，并覆盖了 `record_ids` / `link_record_ids` / `id` / `record_id` / 裸字符串五种写法。单选字段（老师、课程类型）返回的是裸字符串而不是数组，时间是毫秒时间戳。

## 学生月度链接与二维码

- 每个「学生档案 ID × 课程月份」有一个签名链接。单张 PNG、批量 ZIP、任务 CSV 使用同一个地址。批量下载按学生去重，图片标题为「11月 · 学生名 · 月度反馈」。
- 已发链接的课程月份固定。重新「生成名单」后，学生下次打开或重新读取就看到新增和移除的待评老师。已有答卷的任务按原规则保留。下个月切换课程月份并发送新码，旧码可以查看已收集的结果状态。
- 学生页（短地址 `/m/`）是菁仕自己的一屏一题问卷，不再嵌飞书表单；答案由 `feedback-api` 写回飞书答卷表并直接绑定任务。学生和家长使用同一个月度链接，第一题选身份。老师条分别显示学生、家长或双方已评。已提交的进度跨设备恢复，未提交的草稿存在这台设备上。教务体验版：<https://app.jsjy.asia/m/#demo>。改题流程见下面的详细文档。
- 学生在内嵌的飞书原问卷填写提交，再点「我已提交，确认进度」。服务端查到匹配答卷后标记完成并切到下一位。原有对账负责评分更新。旧飞书直链和 `/t/<token>` 继续可用。
- 同月复制、导出复用已签发地址，二维码和 ZIP 在浏览器生成。学生打开只读该学生该月份的任务，不同步课表或飞书全表。详见[正式接入和资源估算](./docs/student-monthly-feedback.md)。

## 工作台

列表显示学生 / 老师 / 课程 / 负责人 / 状态 / 谁评了，学生二维码固定在右侧。

- **顶部横幅**：人员对不上的反馈放在页面最上方，自动判断是「老师名写法不同」「学生名写法不同」
  还是「这对组合当月没排课」，前两种给下拉候选（只列这个学生的老师 / 这个老师的学生），
  选中即写入别名表，下次同步自动对上；第三种给手动绑定。
- **筛选**：搜索 + 老师（多选）+ 学生（多选）+ 谁评了（学生已评/未评、家长已评/未评、双方都评）。
  两个多选都带搜索框和全选/清空——89 个学生不带搜索没法用；用 Popover 而不是 DropdownMenu，
  后者的 typeahead 会抢走输入框按键。统计卡**点击只筛表格，数字始终是当月全量**，
  否则点「已发未填」后「应发」会跟着变，指标就没意义了。
- **批量**：勾选后底部浮出操作栏，明确写着「已选 N 行 / 当前筛选 M 行 / 共 K 行」，
  并提供「选中全部筛选结果」。操作包括标记已发 / 拒绝 / 退回未发、二维码 ZIP、导出 CSV。
- **行抽屉**：二维码预览与下载、复制短链接、打开问卷、发送时间、提交时间、谁评了、绑定方式。

## 老师评分（原「老师反馈加权看板」）

页面顶部「问卷跟踪 | 老师评分」切换（`#/scores`），同一个登录。老看板 <https://jingshi-feedback-service.vercel.app/> 的功能都搬了过来，
不用再导出 CSV、再上传。

- **月度评分**：课程月份 M = M 月课表（评价过的按定稿课时）+ 归属 M 月课程的反馈（M 月提前交的和 M+1 月交的）。排名图（总评分 / 三项指标 × 总 / 学生 / 家长，前半区绿、后半区蓝，
  21 人则前 11 名为前半区）、明细表、点老师打开抽屉看分项、份数和每一条反馈。导出 Excel、评分表 CSV、完整排名 PNG。
- **续课预警**：老师抽屉的每份学生反馈直接显示该学生与该老师当月/次月的课程数；次月 0 节或减少会用带文字和图标的橙色提示。数据来自「生成名单」已存的课程任务；次月尚未生成时显示「课表未同步」，不误报为未续课。
- **累计评分**：按老师每月实际课时加权平均，可选月份范围；导出 Excel（含逐月贡献）和与老看板 `teacher_scores.csv`
  同格式的 CSV（家长报告 `sync:cumulative-teacher-scores` 直接可用）。
- **文字评价**：按老师分组看改进方向和文字建议，默认只看有具体建议的，可搜索、导出。
- **排除老师**：和老看板一样勾选即排除、剩下的重新排名，只影响自己的浏览（记在本机）。长期不参与统计的老师在问卷跟踪页
  「不统计的老师」里设，两边都生效。

### 存结果，不现算

每个课程月份的结果（老师分数含分项、逐条明细）存在 `feedback_score_results`，**页面直接读这张表**：切月份、切标签、
改累计范围、排除老师都不调云函数（累计和重排名在浏览器里算，`src/web/scoring.ts`，与 Python 脚本逐位一致，有测试锁住）。

| 时机 | 做什么 |
|---|---|
| 飞书事件 / 每日定时对账 / 「刷新反馈」 | 存这一轮的答卷快照；对应课程月份的输入（课表快照 + 定稿课时 + 答卷快照 + 别名 + 算法版本）做哈希，**变了才**调 `feedback-score` 重算并存库 |
| 「生成名单」 | 存课程月份课表快照，同上按哈希决定是否重算 |
| M+2 月第一次定时对账或「刷新反馈」 | 课程月份 M 定稿：先重新生成一次 M 月名单（课表快照换成实际上过的课，老师总课时用它），再全量对账、算一次，标为 `final`，之后不再自动重算。飞书事件里不做（要读整张课表约 40 秒，飞书要求 3 秒内回应） |
| 「发布定稿」（老师评分页，月度评分） | 课程月份 M 过完、还在收集晚交反馈时提前定稿：同上重新生成名单、全量对账、算一次，标为 `final`，记下 `published_at` / `published_by`。M+2 月初的自动定稿看到已定稿就跳过。算不出分数（`error`）不发布 |
| 有月份定稿后（自动或发布） | `POST SITE_REVALIDATE_URL`（官网 `/api/revalidate`，带 `SITE_API_KEY`），官网马上重取老师数据；没通知到就等官网每天自己取一次 |
| 手动 | `callFunction({ action: "recompute-scores", courseMonth })`：改了别名等口径后强制重算某月（含已定稿的，重算后仍是定稿） |

资源点：平时打开、切换零计算；答卷有变化时一次计算约 0.4 秒（128MB）。

### 口径

- **2026-09 课程月份起按快照计算**（`LIVE_SCORES_FROM`），重复反馈只算第一份，和问卷跟踪的占位规则一致；问卷跟踪页列出重复提交提醒教务。
- **之前的月份是已公布的定稿**（`source = history`）：分数、课时、份数原样取自老看板 `monthly_score_contributions.csv`，不改。
  学生/家长分项和逐条明细是按原始反馈**补算**的：2026-05 起用飞书答卷，02–04 月用老看板留下的
  `outputs/teacher-feedback/<月>/respondent_detail.csv`（飞书里已经没有这些月份的答卷和课表）。
- 累计评分按老看板公式在浏览器里重算：用同样输入（02–08 月），46 位老师的排名和三位小数与 Python 结果逐位一致。
  老看板那份「官方 9 月」（每位老师只有 1 个有效分，像是早期不完整数据）已由计算结果取代。
- 姓名统一用本系统的别名表；老看板 `name_mapping.csv` 的老师写法已导入（Valentina林 → Valentina Lin、刘峥 → Kevin Liu、高 → 高志勇），
  显示名一律用课表写法。
- 课表先按上面「是否课程」过滤再交给评分脚本（`keepCourseLessons`），咨询、模考、作业这类占位不算老师课时、也不参与权重。
  只影响 2026-09 起的月份；「课程类型」页改设定后会立即重算未定稿月份。
- **4 分按 5 分算**（业务方 2026-10 定，2026-09 课程月份起生效，之前的已公布月份不重算），实现在 `functions/feedback-score/index.py`：
  - 连续 4 分：同一评价人（学生或家长分开算）给同一老师的同一项，前 3 个月都是 4 分、每个月都有这位老师的课，本月仍有课又打 4 分 → 本月按 5 分；
  - 历史评分标准高（算法版本 6）：学生、家长分开，检查本月之前所有可用课程月份的原始有效评分。至少 **4 个不同历史月份**（超过 3 个月，可不连续）在所有老师、三个评分指标中的最高分为 4，且整个历史从未打过高于 4 的分数；本月最高原始分仍为 4 → 本月有课、匹配成功的 4 分按 5 分算，低于 4 分不变。不要求评价多位老师、不设 12 个月窗口。只有 1～3 分的历史月份不计入达标月份；未填、未匹配课时、重复答卷不凑月份，本月和未来月份不作为历史。
  - 此规则替代旧的「当月给 2 位老师打分且最高为 4」规则；另一条「连续 4 分」保持独立生效，两条同时命中只升一次，优先记「连续 4 分」。历史任意老师、任意指标的原始 5 分都会阻止「历史评分标准高」，但不阻止独立的「连续 4 分」。
  - 明细里存原始分，另记 `adjusted`（被改的字段和规则），下个月两条规则都用原始分判断；课时、份数、覆盖率不受影响。
    页面上明细显示为 4→5，月份状态栏写出本月改算了多少项。历史规则标记为 `historical-strict-rater`；既有定稿里的 `strict-rater` 继续显示「旧规则」，不自动重算已公布月份。
  - 可持续 curve：升分只在临时计算副本里把 4 改为 5，持久化 `detail.scores` 始终是原始 4，`adjusted` 单独记录命中规则。下个月只读原始 `scores`，不会因为上个月 curve 成 5 而失去资格；历史输入必须保留纯 5 分答卷，不能只筛选含 4 分的行。
- 评分脚本只加了一个参数 `dedupe_keep`（默认 `last`，老看板行为不变），其余算法一行没改。

### 历史 curve 的运维成本

- 不加定时器、轮询或打开页面触发的计算，沿用现有评分重算入口；查询仅取本月之前的 `course_month,detail`，一次批量读取替代原来的 3 次逐月读取，投影原始分后传给评分函数。上线前须按仓库规则确认既有自动重算频率；本次代码修改不读写线上数据。
- 估算示例（非新增频率）：每月重算 100 次，历史读取 API 请求从 300 次降为 100 次，约少 2 点；若每次历史处理额外耗时 0.5 秒、评分函数 128MB，计算约增加 0.7 点/月。历史明细读取量和传输量随月份增长，未查询生产数据，实际耗时、流量点数上线时再量测。
- 无需人工每月开通 curve 资格。排查时对照老师反馈明细里的原始 `scores`、`adjusted` 和当月 `adjustedScores`；修改历史输入后，未定稿月份下次刷新会因输入哈希变化重算，已定稿月份仍须明确手动重算。

## 与老师反馈系统衔接

工作台底部的「导出课表」「导出反馈」仍保留（老看板还能用）。导出课表的「学生」列曾经整列为空（关联字段读错了键），已修复。

| 文件 | 范围 | 用途 |
|---|---|---|
| 问卷任务 CSV | 当前筛选结果 | 教务自己核对 |
| 课表 CSV | 课程月份 | 老看板上传用 |
| 反馈 CSV | 收集月份 | 同上 |

时间一律写成上海时区的墙上时间（`YYYY-MM-DD HH:mm:ss`，不带时区后缀）。评分脚本用 `datetime.strptime` 解析再按 `%Y-%m` 比对月份，带时区后缀或 UTC 时间会让整月数据被判成"不在报表月份"。`tests/export.test.ts` 锁死了这个格式。

完整需求、设计和实施任务见 [`specs/monthly-course-feedback-tracker`](../../specs/monthly-course-feedback-tracker)。

## 飞书登录

网页（`/feedback/`、`/cancellations/`、`/ielts/`、`/income/`）点「用飞书登录」→ `feedback-api` 的 `/auth/feishu/start` → 飞书授权 → `/auth/feishu/callback` 按 open_id 查
`feedback_admins` → 签 CloudBase 自定义登录 ticket，跳回网页（ticket 放在 `#` 后）→ 网页 `signInWithCustomTicket`，
再调 `bind-feishu` 把当前 CloudBase 用户 ID 写进白名单行的 `user_id`。RLS 和各云函数仍按 `user_id` 判断，业务表不用改。
纯逻辑在 [`src/server/feishu-login.ts`](./src/server/feishu-login.ts)（有单测）。

一次性配置：

1. CloudBase 控制台「身份认证 → 登录方式」开启自定义登录，下载私钥文件放到本目录（`tcb_custom_login*.json` 已 gitignore），
   `server.env` 写 `CLOUDBASE_LOGIN_KEY_FILE=文件名`。
2. CloudBase「HTTP 访问服务」在 `app.jsjy.asia` 上加路径 `/auth` → 云函数 `feedback-api`（同 `/classroom-api` 的配法）。
3. 飞书开放平台（`feedback-api` 用的应用）：开启网页应用登录和「获取用户基本信息」权限，
   「安全设置 → 重定向 URL」加 `https://app.jsjy.asia/auth/feishu/callback`，发布新版本。
4. 执行 [`migrations/202610160001_feishu_login.sql`](./migrations/202610160001_feishu_login.sql)。
5. `server.env` 补 `FEISHU_LOGIN_BASE_URL`、`LOGIN_ALLOWED_ORIGINS`（见 `server.env.example`），然后部署函数和网页。

谁能登录：飞书开放平台里这个应用的「可用范围」（当前是全员）。走完飞书授权的人第一次登录时自动写进 `feedback_admins`，不需要审批。
要挡住某人，在飞书开发者后台把他移出可用范围（只改 `active=false` 没用，下次登录会被改回）。

能看什么（只管月度课程反馈这一个产品，取消课程、雅思、薪资预警等不受影响）：`feedback_admins.role`，迁移 `202611110001_feedback_roles.sql`，口径在 `src/shared/roles.ts`。

| 权限 | 能看 |
|---|---|
| `teacher`（新账号默认，「普通老师」） | 问卷跟踪、老师评分（分数、排名、学生/家长分项）、课程类型；看不到每份反馈是谁评的、文字评价、未评价名单，没有「导出反馈」「发布定稿」 |
| `admin`（「可看反馈详情」） | 全部内容 |
| `super`（「超级管理员」） | 再加「管理员设置」：给每个账号改权限（不能改自己） |

上线时的初始名单：徐翰超 `super`；黄钢、罗健文、包天翊 `admin`；其余 `teacher`。
数据库是真正的门：`feedback_score_results`（`detail` 列是逐份明细）和答卷快照（`kind=feedback` 是答卷原文）只给 `is_feedback_detail()`；
分数走视图 `feedback_score_summaries`（不含 `detail`），页头同步时间走视图 `feedback_sync_times`。`feedback-api` 的 `export-feedback-csv`、`publish-scores` 也按 role 拦。

open_id 按飞书应用区分，菁仕课堂（`classroom-recorder`）后台名单里的 open_id 不能直接拿来用。
