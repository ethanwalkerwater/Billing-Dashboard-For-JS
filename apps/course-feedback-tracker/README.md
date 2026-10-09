# 月度课程反馈问卷跟踪系统

面向教务老师的 CloudBase 应用。选择收集月份后，系统读取上一个自然月的完整飞书课表，按「课程月份 + 学生 + 老师」生成一份问卷任务，跟踪未发、已发未填、已填写、拒绝填写四种状态，并导出可直接喂给现有老师反馈报表系统的 CSV。

- 工作台：<https://app.jsjy.asia/feedback/>（自有域名，静态托管的 `/feedback/` 子目录，和雅思正向率 `/ielts/`、教师薪资预警 `/income/` 并列）。
  根目录 `/` 是跳转页（`root-redirect/index.html`），旧链接、默认域名根目录、收藏的 `#/scores` 会原样带过来
- 工作台短链接：<https://jingshi.vercel.app/feedback>（Vercel 门户 307 跳转到上面的地址）
- 默认域名（仍可用）：<https://jingshi-test-d5gp401i44a0fa7a7-1300607705.tcloudbaseapp.com>
- 自有域名配置（2026-10）：腾讯云 SSL 免费证书（`app.jsjy.asia`，90 天，已开自动续费，到期 2027-01-06）；
  CloudBase「HTTP 访问服务」自定义域名 + 路由 `/` → 静态托管（`STATIC_STORE / staticstore`，控制台下拉选不到，用
  `tcb routes add` 加的）；DNSPod 记录 `app CNAME app.jsjy.asia.tcbaccess.tencentcloudbase.com`；安全域名已加 `app.jsjy.asia`。
  证书续期后若 CloudBase 没自动换上，到「静态网站托管 → 基础配置」重新选证书。主域名 `jsjy.asia` 是官网（另一台服务器），不要动。
- 门户入口：<https://jingshi.vercel.app/> 「学生反馈追踪系统」（源码在 `~/Documents/GitHub/菁仕后台主页`）
- 教务账号：`jsjy`（另有一个以邮箱登录的备用账号）。**密码不写进仓库**，见 CloudBase 控制台的
  「身份认证 → 用户管理」，或问项目负责人。
  业务方原本要 `jsjy / jsjy`，但 CloudBase 密码策略要求 ≥8 位且至少 3 类字符（大写/小写/数字/符号），
  实测 `jsjy` 直接报 `Invalid password length`，所以用了最接近的可接受形式。
  登录不能去掉：所有学生/老师数据都靠 RLS 的管理员白名单保护，匿名访问等于公开。
- 旧版短链接（仍可用，仅供已印出去的码）：`https://jingshi-test-d5gp401i44a0fa7a7-1300607705.ap-shanghai.app.tcloudbase.com/t/<token>`
- 飞书事件回调：`https://jingshi-test-d5gp401i44a0fa7a7-1300607705.ap-shanghai.app.tcloudbase.com/webhooks/feishu`

## 架构

测试环境的 CloudBase 数据库是 PostgreSQL 17，因此采用「前端直连 + 单云函数」的形态，而不是 design.md 里最初设想的三函数 + 云存储方案：

| 部分 | 做法 |
|---|---|
| 任务列表、筛选、统计、改状态、任务清单导出 | 浏览器用 `@cloudbase/js-sdk` 的 `rdb()`（PostgREST）直连数据库，RLS 只放行 `feedback_admins` 里的管理员 |
| 飞书课表同步、答卷对账、扫码短链接 302、飞书事件回调、课表/反馈 CSV 导出、老师评分取数 | 云函数 `feedback-api`（Node） |
| 老师加权评分计算 | 云函数 `feedback-score`（Python 3.10，128MB），**纯计算、一次一个月**：直接复用 `apps/teacher-feedback/scripts` 的脚本（打包时复制），不读库、不碰密钥；只在数据变了时由 `feedback-api` 调用，结果存 `feedback_score_results` |
| 二维码单张 PNG 与批量 ZIP | 浏览器里用 canvas + JSZip 生成，不经过云存储。**二维码直接编码带预填的飞书表单链接**，扫码零中转 |
| 界面 | shadcn/ui 默认主题（zinc），Tailwind v4；组件按 shadcn 源码手写在 `src/components/ui/`（button/badge/card/input/checkbox/table/sheet/select/alert/separator） |
| 状态变更审计 | 数据库触发器 `feedback_tasks_status_audit`，前端和云函数都绕不过 |

云函数里 `app.rdb()` 实测拿到的是 `anon` 角色（和没登录的浏览器一样），读写业务表会 permission denied。所以函数自己拼 PostgREST 请求，用环境 API Key 鉴权，该 Key 的 JWT 里 `role=service_role`，可绕过 RLS。见 [`functions/feedback-api/service-db.ts`](./functions/feedback-api/service-db.ts)。

## 当前状态

已完成并在测试环境验证：

- 双月份口径、课表过滤与分组、稳定任务 ID、状态迁移、飞书预填 URL
- 飞书适配器：分页读取、限流重试、字段结构校验（只读，不写飞书）
- PostgreSQL 表结构、索引、RLS 策略、状态审计触发器（已应用到测试环境）
- 云函数 `feedback-api`：已部署，`/t/:token` 302 跳转和飞书 `url_verification` challenge 已实测通过
- 教务前端（V2 单表工作台）：一行一个学生-老师对，状态、谁评了（学生/家长）、最近动作同屏可见；
  顶部横幅直接列出人员对不上的反馈并给出下一步；列可排序、三个筛选器、批量浮动栏、行抽屉
- 静态站点已部署

已用真实数据跑通（2026-09 收集月 / 2026-08 课程月）：

- 全量读取 8594 条课表，生成 **258 份任务、89 位学生、32 位老师**
- 排除 378 条（临时取消 / 非授课），待复核 61 条，课表数据有问题 55 条
- 真实二维码短链接扫开后 302 跳飞书问卷，老师、学生两项预填正确
- 教务账号可登录工作台，RLS 白名单双向验证通过

待办：

- 飞书事件订阅：需要在开放平台配置回调地址和 Encrypt Key / Verification Token

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
tcb db execute --sql "$(cat migrations/202610050001_teacher_scores.sql)"
tcb db execute --sql "$(cat migrations/202610050002_score_results.sql)"
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

- 收集月份是工作台入口；课程月份固定为上一个自然月。
- 带临时取消标记的课程不生成任务。
- 排除判断排在缺字段判断**前面**。真实课表里「请假」「模拟考试」「例会」这类记录本来就没有老师或学生，先查缺字段会把近 300 条/月误报成"课表数据有问题"。
- **只有「课程」生成问卷、计入老师课时和评分**，问卷名单和评分共用一个判断 `src/domain/lesson-kind.ts`（业务方 2026-10 定）：
  1. 「课程类型」页手动设过的以手动为准（表 `feedback_course_type_rules`）；
  2. 课程类型名含咨询/规划/考试/模考/会议/自习/作业/助教/答疑/文书/请假/团建等关键词 → 不是课程（1v1 的「申请咨询」也不算）；
  3. 授课类型为 1v1 / 刷题班 / 1v2班课 / 班课 → 课程；其他授课类型（学生规划、自习、作业、助教、模考…）→ 不是课程；
  4. 没填授课类型、名字也看不出来 → 先按课程处理，列进同步明细「未标注授课类型」和「课程类型」页「待复核」。
- 改了判断后「生成名单」会删掉不再是课程、也没人填过的任务；已经有人填过的保留，列在同步明细里。
- 同一学生与同一老师当月的多门课程合并到一份任务。
- 答卷按**提交时间**（上海时区）归属收集月份：9 月提交的就是 9 月这一轮的反馈。
- **业务方决定：不往飞书反馈表加任何字段，不用任务 ID。** 答卷只按（学生姓名, 老师姓名）匹配任务：
  NFKC 规范化、去空格、忽略大小写后精确相等，外加 `feedback_name_aliases` 别名表
  （`Valentina 林 → Valentina Lin`、`顾子言 → 顾子言Tina` 这类）。**不做模糊匹配**。
- 每个任务有学生位置和家长位置各一个（按问卷「身份」字段），任一位置有答卷即为「已填写」；
  同一身份的第二份标 `duplicate`。
- 对不上的答卷标 `unlinked`，在「对不上任务的答卷」里带原始姓名列出来，教务加别名或手动绑定
  （`feedback_responses.bound_by='manual'` + `task_id`，重新同步时保留）。
- 系统对飞书唯一的写操作：「生成名单」时把本月课表学生**追加**进问卷「学生姓名」下拉（只加不删，删单选选项会清空历史答卷的值）。
  姓名取学生表「学生姓名」，不是课表关联字段里的「姓名-手机尾号」。老师下拉缺的名字仍只提示，由教务手动加。
- 飞书里删掉的答卷（或学生、老师都没填的空行）在下一次全量对账（打开工作台 / 「刷新反馈」）时从库里清掉，
  并腾出任务上的学生/家长位置；两个位置都空了的「已填写」退回「已发未填」。飞书整表读回 0 行时不清理，防误删。
- 「不统计的老师」名单（`feedback_excluded_teachers`，所有月份通用）：任务照常生成和对账，只在工作台统计、表格、横幅里隐藏。
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

## 二维码

- 编码内容是 **飞书表单链接 + 预填的老师/学生姓名**（`VITE_FEISHU_FORM_URL`），不再经过我们的 `/t/<token>` 302。
  答卷按姓名匹配回任务后，那一跳没有任何作用，只剩冷启动延迟和腾讯默认域名的拦截页。
- 卡片 810×1013（浅灰底 + 白色圆角卡 + 细边框）。自上而下：老师名（72px 粗体，学生一次收到几张、
  缩略图里就得认出评谁）→ 课程 → 学生 → 二维码 → 「反馈完全匿名，你的善意会帮助老师变得更好」→
  官网同款 logo + 菁仕教育。
- 批量下载走弹窗：实时进度、可中途取消、完成后显示文件名和体积。ZIP 里**按学生分文件夹**
  （`学生名/老师名-课程月份.png`），教务可以整个文件夹发给家长。
- 性能实测（258 张）：约 14 秒，ZIP 16 MB，单张 PNG 63 KB。几处关键决定：
  - ZIP 用 `compression: "STORE"`——PNG 已经是压缩格式，再 DEFLATE 一遍纯属白烧 CPU。
  - 画布和 logo 全程复用，不是每张重新分配。
  - 每张之间 `setTimeout(0)` 让出主线程，否则进度条不动、界面假死。
  - 二维码用 `scale`（每模块整数像素）而不是 `width`：`width` 会缩放出抗锯齿灰边，颜色数暴涨。
  - 保留 PNG 不换 WebP：WebP 能再小 4 倍，但二维码是无损格式更稳妥——扫不出来比文件大得多严重。
- `/t/<token>` 端点保留，之前打印的码不失效。

## 工作台

一张表看完全部：学生 / 老师 / 课程 / 状态 / 谁评了 / 最近动作 / 二维码。不用切 tab。

- **顶部横幅**：人员对不上的反馈放在页面最上方，自动判断是「老师名写法不同」「学生名写法不同」
  还是「这对组合当月没排课」，前两种给下拉候选（只列这个学生的老师 / 这个老师的学生），
  选中即写入别名表，下次同步自动对上；第三种给手动绑定。
- **筛选**：搜索 + 老师（多选）+ 学生（多选）+ 谁评了（学生已评/未评、家长已评/未评、双方都评）。
  两个多选都带搜索框和全选/清空——89 个学生不带搜索没法用；用 Popover 而不是 DropdownMenu，
  后者的 typeahead 会抢走输入框按键。统计卡**点击只筛表格，数字始终是当月全量**，
  否则点「已发未填」后「应发」会跟着变，指标就没意义了。
- **批量**：勾选后底部浮出操作栏，明确写着「已选 N 行 / 当前筛选 M 行 / 共 K 行」，
  并提供「选中全部筛选结果」。操作包括标记已发 / 拒绝 / 退回未发、二维码 ZIP、导出 CSV。
- **行抽屉**：二维码预览与下载、复制短链接、打开问卷、谁评了、绑定方式。

## 老师评分（原「老师反馈加权看板」）

页面顶部「问卷跟踪 | 老师评分」切换（`#/scores`），同一个登录。老看板 <https://jingshi-feedback-service.vercel.app/> 的功能都搬了过来，
不用再导出 CSV、再上传。

- **月度评分**：课程月份 M = M 月课表 + M+1 月收到的反馈。排名图（总评分 / 三项指标 × 总 / 学生 / 家长，前半区绿、后半区蓝，
  21 人则前 11 名为前半区）、明细表、点老师打开抽屉看分项、份数和每一条反馈。导出 Excel、评分表 CSV、完整排名 PNG。
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
| 「刷新反馈」（打开任一页面会自动执行） | 存本月答卷快照；对应课程月份的输入（课表快照 + 答卷快照 + 别名 + 算法版本）做哈希，**变了才**调 `feedback-score` 重算并存库 |
| 「生成名单」 | 存课程月份课表快照，同上按哈希决定是否重算 |
| 新的收集月份第一次刷新 | 把上个月的答卷再全量拉一遍、算一次，标为 `final`（定稿），之后不再自动重算 |
| 手动 | `callFunction({ action: "recompute-scores", courseMonth })`：改了别名等口径后强制重算某月（含已定稿的） |

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
  - 评分标准高：本月给 2 位及以上老师打过分、所有老师所有项都没打过 5 分 → 他的 4 分都按 5 分，4 分以下不变；只评 1 位老师的不算。
  - 明细里存原始分，另记 `adjusted`（被改的字段和规则），下个月判断「连续」用原始分；课时、份数、覆盖率不受影响。
    页面上明细显示为 4→5，月份状态栏写出本月改算了多少项。
- 评分脚本只加了一个参数 `dedupe_keep`（默认 `last`，老看板行为不变），其余算法一行没改。

## 与老师反馈系统衔接

工作台底部的「导出课表」「导出反馈」仍保留（老看板还能用）。导出课表的「学生」列曾经整列为空（关联字段读错了键），已修复。

| 文件 | 范围 | 用途 |
|---|---|---|
| 问卷任务 CSV | 当前筛选结果 | 教务自己核对 |
| 课表 CSV | 课程月份 | 老看板上传用 |
| 反馈 CSV | 收集月份 | 同上 |

时间一律写成上海时区的墙上时间（`YYYY-MM-DD HH:mm:ss`，不带时区后缀）。评分脚本用 `datetime.strptime` 解析再按 `%Y-%m` 比对月份，带时区后缀或 UTC 时间会让整月数据被判成"不在报表月份"。`tests/export.test.ts` 锁死了这个格式。

完整需求、设计和实施任务见 [`specs/monthly-course-feedback-tracker`](../../specs/monthly-course-feedback-tracker)。
