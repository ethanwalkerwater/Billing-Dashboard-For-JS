# 菁仕课堂（classroom-recorder）

老师在自己的 Mac / Windows 电脑上装「菁仕课堂」，用飞书登录后，App 按飞书课表自动录课、边录边传；下课后云端把录音转成文字，生成一段可直接发给家长的课堂总结和一份完整的课堂学情报告，再用飞书私信通知老师。

- 设计与接口约定：[`docs/design.md`](docs/design.md)；产品方案：[`../../docs/课堂录制.html`](../../docs/课堂录制.html)；报告网页原型：[`../../docs/classroom-report.html`](../../docs/classroom-report.html)。
- 随时录制：屏幕右侧的悬浮按钮（几秒不碰会淡下去）或菜单栏「随时录制」，不需要课表；结束时填主题、选「课程」（出家长总结 + 学情报告）或「会议」（出会议纪要）。
- 后台：`https://app.jsjy.asia/classroom/admin/`，飞书登录。老师（「老师信息」表里有的）只看自己的课程和会议，可以改转写、在报告网页上改文字；超级管理员 = `ADMIN_OPEN_IDS`（创建者）+ 后台「管理员」页里加的人（`classroom_admins` 表），看全部老师。按课程听 / 下载录音、看 / 下载转写、看家长总结和学情报告；改提示词，用已有课程、上传音频或粘贴转写试生成，和线上版本并排对比，确认后「应用到全部老师」。
- 完整报告：`https://app.jsjy.asia/classroom/report.html?t=<token>`，不需要登录，靠 32 位随机 token 防猜。只有白天模式。加 `&edit=1`（后台报告页的「编辑」）进编辑模式：用后台的登录，点文字原地改，支持简单 Markdown，版式不变；第一次改时 AI 原稿存进 `rawReport`。「下载 PDF」调用浏览器打印，另存的文件名为 `学生_课程_日期_课堂学情报告`。

## 菁仕工作台

`https://app.jsjy.asia/work/`（旧地址 `/classroom/workbench/` 也能打开；`deploy:web` 把同一个页面改成绝对资源路径另传一份到 `/work/`），飞书登录（和后台共用登录和 token）。界面照 [`docs/学生档案.html`](../../docs/学生档案.html) v9 原型，产品档案见 [`docs/PRODUCT.md`](../../docs/PRODUCT.md)。代码：`src/workbench/`（网页，原生 JS）、`functions/classroom-api/workbench.ts`（接口 `/classroom-api/wb/*`）、`src/server/workbench.ts`（纯逻辑，前后端共用）、`tests/workbench.test.ts`。

| 角色 | 是谁 | 看什么 |
|---|---|---|
| 老师 | 老师档案对上的人，按「课表名」筛课表 | 自己的课表；「我的学员」= 最近 90 天给他上过课或已排课（开会、考试、取消的不算），列表只列自己的课，这个月没有自己课的学生排在下面并显示上次上课；学生档案里能看到其他科；看不到标记、备注、归属老师、服务老师、渠道 |
| 教务 | `wb_roles`，管理员在「录课管理 → 教务」里加 | 全部学员和课表，在列表里直接改阶段，标记、备注、跟进、列设置、新建学员 |
| 管理员 | `ADMIN_OPEN_IDS` + `classroom_admins` | 教务的全部，加录课管理（链到原后台）和教务名单；账号菜单里能「以老师身份查看」 |

不在老师档案里、也不是教务的人登录会被拦下，名字记进 `wb_people` 并私信管理员，管理员在「录课管理 → 教务」里直接选他。

数据：

- 课表、学员信息是飞书的快照，存在 `wb_cache`（`m:YYYY-MM` 一个月一行紧凑数组，`roster` 一行）。打开页面先用快照，过期了网页再调一次 `/wb/sync`：当月和下月 10 分钟、更早的和更晚的一天、学员信息 30 分钟，「刷新」按钮 1 分钟。同一时间只有一个人去拉飞书（按 `syncedAt` 原子领取）。没有定时器。
- 每节课的学情来自 `classroom_lessons`（合并反馈算到它合并的每一节上）；家长总结用老师改过的那份。
- 工作台自己的数据：`wb_students`（阶段、画像、目标）、`wb_marks`（每门课每月每列一个值）、`wb_config`（列设置）、`wb_monthly`（AI 月报）、`wb_milestones`、`wb_grades`、`wb_todos`、`wb_suggestions`（AI 画像建议）。附件存 `classroom` 桶 `wb/{学生}/…`，单个不超过 2 MB，图片在浏览器里先压缩。
- 月报：第一次打开「月度记录」时按当月有报告的课生成一次（DeepSeek），存起来；「掌握得好 / 还要巩固」按每个知识点最后一次状态直接算，模型只写两句话。当月有新报告时菜单里「按最新报告重新生成」，上个月的有新报告且没人改过会自动重出一次。
- 画像建议：打开档案时，有报告的课比上次多了才调一次模型，只用词表里的标签、要两节课的证据，采纳才写进画像，忽略的 30 天内不再提。
- 家长收集表：档案里「发收集表给家长」复制一个不用登录的链接（`/classroom/workbench/form.html?t=…`，接口 `/classroom-api/wb-form`），家长点选学习偏好、辅导经历、家长沟通三块（同一套词表）再写一句，提交后并进画像，来源记成「妈妈填的收集表」。
- 成绩单识别：上传截图或 PDF 后调腾讯云「通用文字识别」（GeneralBasicOCR，PDF 取第一页），再让 DeepSeek 整理成行，网页上核对后保存；同一场考试已录过的标灰跳过。**要先在腾讯云控制台开通文字识别**（每月 1000 次免费），没开通时提示后转手动填写，原件照样保存。
- 交接卡：同一门课换了老师（新老师 30 天内第一次上或马上要上），新老师的那节课上和档案概览里出现交接卡（目标、上一位老师最后一次报告讲到哪、要巩固的、作业、画像），新老师点「我看过了」（教务可以替他确认）；没确认前教务的跟进里有一条系统提醒。
- 新建学员写进飞书「学员信息」（姓名、学校、学制、初始年级、联系方式、渠道，在读）；阶段只存在工作台（飞书没有阶段字段，「排课提醒」只用来推默认阶段）。

资源：打开一次约 0.3–0.6 秒（512 MB），一次同步两个月约 3–4 秒；按十几个人每天打开几次估，每月几百个资源点，月报和画像建议的模型调用另算（每份几秒）。函数返回头 `x-wb-ms` 是函数里实际花的毫秒数。

## 架构

```
桌面 App（Tauri，src-tauri + src/desktop）
  │ 30 秒一段 MP3（约 120 KB）
  ▼
classroom-api（CloudBase HTTP 云函数，/classroom-api）
  ├─ 飞书网页登录 → 老师档案「飞书账号」→ 课表名
  ├─ /lessons：课表（最近 7 天 + 明天）+ 数据库处理状态
  ├─ 分段上传 → Storage 私有桶 classroom：{课表记录ID}/{seq}.mp3
  └─ finish 时立即推进；转写完成由腾讯云回调 /asr/callback 推进；每 30 分钟定时器兜底（失败重试、回调丢失、App 没回来的课、清理过期录音）：
       queued → 按序拼接 MP3 → 腾讯云录音文件识别（说话人分离，带 CallbackUrl）
       → transcribing → 大模型判断哪个说话人是老师，转写标成「老师 / 学生」，删掉分段只留 merged.mp3
       → summarizing → ① 整节课一次抽「课堂时间档案」（环节首尾相接、课堂瞬间、作业 / 下节课等事项；超过 12 万字才切开），程序检查
                     ② 只拿学习环节（闲聊、课前课后、课间不交给模型）写家长总结和报告 → ③ 用报告的知识点名把学习环节归成 8–12 章
                     作业、下节课、章节时间、各类分钟数由程序按档案算（会议纪要仍是超过 12000 字先分段摘要再汇总）
       → done：生成报告 token，飞书私信老师
报告网页（静态托管 /classroom/report.html，src/report）
```

代码：`functions/classroom-api/index.ts`（路由与 IO）、`src/server/logic.ts`（纯逻辑：课表解析、状态推进、转写格式、提示词与输出校验）、`src/report/`（报告网页）、`tests/server-logic.test.ts`。

### 数据库（CloudBase PostgreSQL，表结构 `migrations/202610160001_classroom.sql`）

本环境是 PostgreSQL 版：没有文档型数据库，node-sdk 的云存储接口也不可用（`STORAGE_NOT_SUPPORTED`）。云函数用环境 API Key（service_role）直连 PostgREST（`/v1/rdb/rest`）和 Storage（`/v1/storages`），同 course-feedback-tracker。列名与 `LessonDoc` 字段一一对应，按字段局部 PATCH。

| 表 | 主键 | 内容 |
|---|---|---|
| `classroom_auth` | 登录 state | `status` pending / done / not_teacher，10 分钟过期；App 领取 token 后删除 |
| `classroom_sessions` | token 的 sha256 | `openId`、`name`、`scheduleName`。不存 token 明文；目前不过期，删行即吊销 |
| `classroom_lessons` | 飞书课表 record_id | 老师 openId、学生、课程、时间；`stage`、`finish`、`asrTaskId`、`transcript`、`summary` / `editedSummary`、`report`、`archive`（课堂时间档案，含闲聊，只在后台看）、`reportToken`、`gapMinutes`、`audioSec`（实际录音秒数）、`rawTranscript`（后台第一次改转写前的原文）、`copied`、`attempts` / `error`、`lockedUntil`（处理租约）；`kind = merged` 的行是老师选几节课合并的一份反馈，`sources` = 那几节的编号，没有录音和转写（见 docs/design.md「合并反馈」） |
| `classroom_segments` | (`lessonId`, `seq`) | 每段的 sha256、字节数、Storage 对象名 |
| `classroom_prompts` | `version` | 后台保存的提示词（通用规则 / 家长总结 / 学情报告 / 会议纪要四段；早于会议纪要的版本该列为空，读取时用默认），版本号最大的一行是线上；一行都没有时用 `logic.ts` 的 `DEFAULT_PROMPTS`（版本 0）。课程的 `promptVersion` 记生成时用的版本 |
| `classroom_admin_sessions` | token 的 sha256 | 后台登录，30 天过期 |

Storage 桶 `classroom`（私有）：分段 `{lessonId}/{seq}.mp3`（转写入库后删除）与合并后的 `{lessonId}/merged.mp3`（保留 30 天后删除，转写和总结一直保留），后台测试上传的音频在 `preview/{随机 ID}/audio`（分块拼好即删，拼好的音频不自动清理），腾讯云识别用 6 小时签名链接（`fullSignedURL`）下载。

处理失败会记 `stage = failed`、`failedStage`、`error`，下一分钟从失败的那一步重试，累计 3 次后停止，私信老师（大白话）和管理员（技术原因），App 里显示「没能生成」。下课 2 小时后仍缺分段，就用已有分段出报告，报告页注明「录音缺失约 X 分钟」。App 没发 finish 就不传了（合盖睡着、关机、退出）：课表里的课过了下课时间且 15 分钟没收到分段、随时录制 30 分钟没收到分段，云端就按已结束出报告。档案上线时重出存量报告用 `scripts/rebuild-archive.ts`（先试跑出对比页，确认后把同一份结果写库；家长总结不动）。某节课要重跑：把 `stage` 改回 `queued`（或 `summarizing`）、`attempts` 改为 0，再 `tcb fn invoke classroom-api --params '{"action":"tick","lessonId":"rec…"}'`。

## 需要在后台配置的内容

**飞书开放平台**（应用 = 机器人「课表分析」`cli_a93a4faca0f8dcb6`）

1. 安全设置 → 重定向 URL 加入 `https://app.jsjy.asia/classroom-api/auth/callback`。
2. 开通网页应用登录（用户身份）与「获取用户基本信息」权限；机器人发消息（`im:message:send_as_bot`）；多维表格读取（课表、老师档案）。改完发布新版本。
3. 应用可用范围要覆盖所有老师，否则收不到私信。
4. 老师档案里每位老师要有一行（姓名和飞书姓名一致，课表「老师」写法不同时填「课表名」）。「飞书账号」可以不填：老师第一次登录时按姓名唯一匹配，自动写回「飞书账号」；同名或对不上会提示「老师档案里还没有你」，并私信 `ADMIN_OPEN_IDS` 里的管理员。

**腾讯云**：开通「录音文件识别」，建一个只授 `QcloudASRFullAccess` 的子账号密钥。

**CloudBase**（环境 `jingshi-test-d5gp401i44a0fa7a7`）：HTTP 访问服务新增路径 `/classroom-api` → 云函数 `classroom-api`（与 `/birthday-api` 同样配置在 `app.jsjy.asia` 域名下）。

## 环境变量

复制 `server.env.example` 为 `server.env`（已 gitignore）：

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 「课表分析」应用 |
| `TEACHER_APP_TOKEN` / `TEACHER_TABLE_ID` | 老师档案 `JfncbHflsaXCKTsTyjycnBtYnsf` / `tbl04lXBPk2YkIif` |
| `SCHEDULE_APP_TOKEN` / `SCHEDULE_TABLE_ID` | 课表 `Xb34bXSVRaQk7ysfAQScPZp5nPh` / `tblWoTVtU4lqJoes` |
| `API_BASE_URL` | `https://app.jsjy.asia/classroom-api`，飞书回调由它拼出 |
| `REPORT_BASE_URL` | `https://app.jsjy.asia/classroom/report.html` |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 腾讯云录音识别 |
| `ASR_ENGINE` | 默认 `16k_zh_en_2.0`（大模型 2.0，中英粤 + 方言，0.8 元/小时，同样支持说话人分离）；标准版 `16k_zh` 1.75 元/小时 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | OpenAI 兼容接口，默认 DeepSeek `deepseek-chat` |
| `CLOUDBASE_ENV_ID` / `CLOUDBASE_API_KEY` | PostgreSQL 与 Storage（service_role），同 course-feedback-tracker |
| `ADMIN_OPEN_IDS` | 后台管理员的飞书 open_id，逗号分隔。不在名单里的人登录后台会看到自己的 open_id，发过来加进去再部署 |

## 命令

```bash
npm test -w @jingshi/classroom-recorder            # 单元测试
tcb db execute -e jingshi-test-d5gp401i44a0fa7a7 --sql "$(cat apps/classroom-recorder/migrations/202610160001_classroom.sql)"   # 建表 + Storage 桶；migrations/ 下其余文件按序执行
npm run build:report -w @jingshi/classroom-recorder  # 报告网页 → dist-report/
node apps/classroom-recorder/scripts/deploy-function.mjs --build-only   # 只打包云函数（无 server.env 也可）

# 部署（先 tcb login）
npm run deploy:functions -w @jingshi/classroom-recorder   # 打包 + tcb fn deploy + 创建每分钟定时器
npm run deploy:web -w @jingshi/classroom-recorder         # 报告网页 + 后台 + 工作台 → 静态托管 /classroom

# 桌面 App
npm run app:dev -w @jingshi/classroom-recorder     # 本地调试
npm run app:build -w @jingshi/classroom-recorder   # 本机打包
```

### 发版与更新

1. 改 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的 `version`（例如 0.1.3），提交。
2. `git tag classroom-v0.1.3 && git push origin classroom-v0.1.3`：GitHub Actions 打 macOS（通用版）+ Windows 安装包，用 `TAURI_SIGNING_PRIVATE_KEY` 给更新包签名，产物留在这次构建里。此时老师端什么都不会发生。
3. 构建成功后 `node apps/classroom-recorder/scripts/publish-release.mjs classroom-v0.1.3`（gh 要登录仓库管理员账号）：把安装包传到 CloudBase 静态托管 `https://app.jsjy.asia/downloads/classroom/`，最后传 `latest.json`（上线开关），再在 GitHub 建 Release 留档。
4. 老师打开 App 时（启动、从菜单栏 / 托盘打开主窗口，24 小时最多一次）查 `latest.json`，有新版就在后台下载好，标题栏出现「新版本 x · 重启更新」，老师点了才装（录课中不能装）；设置里也能手动「检查更新」（`src-tauri/src/update.rs`）。`latest.json` 是静态文件，不花云函数资源点。0.1.3 / 0.1.4 还是每小时自动检查并静默安装，会自动升到下一个发布的版本。

首次安装链接：`https://app.jsjy.asia/downloads/classroom/jingshi-classroom-mac.dmg`、`…/jingshi-classroom-windows-setup.exe`。
签名私钥和密码在发版电脑的 `~/.tauri/jingshi-classroom.key(.password)`，同时存在 GitHub Secrets；**丢了私钥，已装的 App 就再也收不到更新**，只能让老师手动重装。
发现新版有问题：先重传上一版的 `latest.json`（`downloads/classroom/<旧版本>/` 里的包还在），挡住还没更新的老师；已经更新的老师要用旧代码打一个**更高版本号**再发一次（更新器只往高版本升）。

在 Mac 上直接打 Windows 安装包（不走 CI）：`brew install llvm lld nsis nasm cmake`、`cargo install cargo-xwin`、`rustup target add x86_64-pc-windows-msvc`。
mp3lame-sys 按「编译机」而不是「目标机」选构建方式，在 Mac 上会走 autotools 失败：复制一份 `~/.cargo/registry/src/*/mp3lame-sys-0.1.11`，把 build.rs 里 `#[cfg(unix)]` 改成 `#[cfg(any())]`、`#[cfg(windows)]` 改成 `#[cfg(all())]`，Cargo.toml 的 `cc` 改成无条件 build-dependency，然后：

```bash
cp src-tauri/Cargo.lock /tmp/Cargo.lock.bak   # patch 会改 lock，打完还原
PATH=/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis \
  -- --config 'patch.crates-io.mp3lame-sys.path="<那份副本>"'
cp /tmp/Cargo.lock.bak src-tauri/Cargo.lock
```

## 当前状态（2026-10-16）

| 部分 | 状态 |
|---|---|
| 纯逻辑 | 课表 → Lesson、状态映射、转写格式、大模型 JSON 校验、流水线推进（含 2 小时缺段兜底、App 没发 finish 的兜底）单元测试通过 |
| 云端部署 | 已上线：云函数 `classroom-api`（每 30 分钟兜底定时器 + 腾讯云转写回调）、HTTP 访问 `/classroom-api`、静态托管 `/classroom`、4 张表与 Storage 桶 |
| 线上端到端 | 2026-10-16 用合成的师生对话（两段 MP3）挂在一节已上完的课上跑通：分段上传（HTTP 访问层 base64 + sha256 校验）→ finish → 合并 → 腾讯云识别 → DeepSeek 家长总结与报告 → `/lessons` 返回 done 与报告链接 → 手机宽度报告页正常。测试数据已全部删除 |
| 课表 | 线上 `/lessons` 读到真实课表；会议 / 例会 /「空出」等没有学生的记录不当课（「空出」常是 00:00–23:00） |
| 飞书登录 | 重定向 URL 与权限已在后台配置并发布；授权链接生成正确，**还没有老师真实登录过** |
| 飞书通知 | 未验证（测试用的是假 open_id） |
| 说话人分离 | 两个不同音色的合成对话 13/13 句分对，大模型判断老师正确（含学生说得更多的口语课样例）；真实课堂效果待验证 |
| 提示词质量 | 只用合成对话试过，需要拿几节真实课对比家长总结的语气与准确度 |
