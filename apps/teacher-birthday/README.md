# 老师生日祝福（teacher-birthday）

教务在飞书维护老师档案。老师生日前 3 天，系统在「教务群 - 生日」发送预填好老师姓名的祝福问卷，由教务转给学生和同事；生日当天 9:00，系统往「菁仕教育大群」发一张卡片，点开是这位老师的专属生日网页：一场 3D 生日派对（精致蛋糕、气球、彩旗、串灯、彩纸礼炮），往下滑镜头连续移动，依次看到拍立得祝福卡片墙和 AI 寄语。

- 网页：`https://app.jsjy.asia/birthday/?t=<token>`。每位老师每年一个链接，不需要登录，靠 token 防猜；本地没有 `t` 参数时显示演示数据（`?demo=0|6|12`）。
- 分享与生日卡片统一使用原始签名链接，不使用短链（2026-10-15 按业务要求撤销演示短链）。
- 老师网页与生日群卡片不显示祝福人数；网页固定文案为「有些感谢和祝福，想在今天说给你听」。教务群提醒仍显示已收到的祝福条数，方便收集。
- 设计与口径：[`specs/teacher-birthday/design.md`](../../specs/teacher-birthday/design.md)；实施计划：[`tasks.md`](../../specs/teacher-birthday/tasks.md)。

## 当前开发状态（2026-10-15 更新）

主要功能已实现，收件人按业务要求切换为两个正式群：生日前提醒发「教务群 - 生日」，生日当天祝福发「菁仕教育大群」。此前的测试演练记录见下文。

| 部分 | 当前实现与验证 |
|---|---|
| 老师档案 | 飞书维护资料、生日、入职时间和在职状态；已有建表补字段脚本。此前记录已从官网导入 22 位老师，本次未逐条复核飞书资料 |
| 生日提醒 | 生日前 0–3 天向教务群发送预填问卷，按生日所在年份记录发送状态；对应日期与重跑逻辑测试通过 |
| 生日问候 | 生日当天发群卡片，支持 @ 老师、课表统计和 AI 寄语；失败后 2 天内补发，统计 / AI 失败可降级，相关测试通过 |
| 祝福网页 | 已在 Chrome 打开[线上 demo](https://app.jsjy.asia/birthday/?demo=6)，确认信封、3D 派对、6 条祝福卡片墙和结尾手写信笺可见。demo 的照片和祝福是占位数据；无效 token 的线上接口返回 `403 INVALID_LINK` |
| CloudBase | CLI 3.8.2 已登录并成功查询上海环境，环境为 `Normal`，静态托管为 `online`；`birthday-api` 为 `Active / Available`，Nodejs20.19、256 MB、300 秒超时，最近更新于 2026-10-10 09:35:46；存在 `daily-9am` 定时器，cron 为 `0 0 9 * * * *` |
| 线上收件人 | 提前提醒发「教务群 - 生日」`oc_ee5597e67ae6a33dfffdb4358b1ecd90`，生日当天发「菁仕教育大群」`oc_b29eb8916144f9b64eb3f4e2c23a8664`；机器人「课表分析」需在两群中 |
| 本地验证 | `npm test -w @jingshi/teacher-birthday`：22/22 通过；`npm run build -w @jingshi/teacher-birthday`：类型检查与生产构建通过 |

正式启用前还需完成：

1. 教务补齐 / 核对生日、入职时间、在职状态、飞书账号与课表名，尤其是刘峥的课表对应关系。
2. 群收件配置已按业务指定切换；后续换群时需同步环境变量，并确认「课表分析」在群内。
3. 经授权在测试群走一遍问卷填写 → 收集祝福 → 群卡片 → 真实 token 网页，并用手机飞书内置浏览器检查图片、视频及降级表现。本次桌面 demo 不代表这条完整链路已重新验收，也未核验近期定时任务执行日志。

`tasks.md` 保留的是早期实施方案，未勾选的步骤不能代表功能尚未开发；其中吹蜡烛 / 星座方案已被当前派对页面替代。当前操作以本 README 和实际代码为准。

## 飞书

都在 wiki「老师数据主表」这个多维表格里（`JfncbHflsaXCKTsTyjycnBtYnsf`），机器人是「课表分析」（`cli_a93a4faca0f8dcb6`）。

| 用途 | 地址 |
|---|---|
| 老师档案（教务维护） | 「数据表」`tbl04lXBPk2YkIif` |
| 新老师入职信息登记（老师填写，需飞书登录） | <https://ccntnl19k0y3.feishu.cn/share/base/shrcniw2TETHFHf5Ejf2kn5yljf> |
| 祝福问卷（教务转发；链接由系统预填老师） | <https://ccntnl19k0y3.feishu.cn/share/base/form/shrcnR5dhvcfKOlxDninRSmsmeb> |
| 收到的祝福 | 「生日祝福」`tblfHGKqIDCCO1M2` |

### 新老师入职登记

2026-10-14 用飞书 CLI 在老师档案表创建「新老师入职信息登记」表单（`vewia2uS9X`）。每次提交新增一条老师档案；已有老师修改资料请联系教务，避免重复登记。

- 必填 10 项：姓名、生日（公历）、入职时间、联系手机号、微信、主学科、可授课课程、学历信息、教学特点、照片。
- 选填 3 项：性别、课表名、个人介绍。系统统计、发送年份、寄语、在职和飞书账号不向填写者展示。
- 分享已启用，持链接的新老师可使用飞书账号登录填写。CLI 已核对题目、必填项、顺序和分享设置；本次未提交测试记录，浏览器访问权限被拒绝，尚未做页面视觉验收。
- 原「手机」为电话字段，CLI 表单不支持作为题目，因此新增文本字段「联系手机号」（`fld2tQwyi4`）收集新老师的号码，原列及历史数据保留。

收到新档案后，教务核对课表名、生日和入职日期，补充飞书账号，并勾选「在职」；生日任务仅处理已勾选在职的老师。

**字段不要改名**，程序按字段名读写。建表脚本 `scripts/setup-feishu.ts` 可以重复运行，只补缺失的字段，不删也不改已有字段。

| 老师表字段 | 谁填 | 说明 |
|---|---|---|
| 姓名、性别、主学科、学历信息、教学特点、可授课课程、照片 | 已从官网「名师团队」22 位导入 | 新老师由教务补 |
| 生日、入职时间 | 教务 | 公历；网页不显示年份和年龄。入职时间决定蜡烛数和「在菁仕的第 N 天」 |
| 手机、微信 | 教务 | 只存档，不上网页 |
| 联系手机号 | 新老师填写入职登记 | 表单专用文本字段；原「手机」列保留历史号码，均不上生日网页 |
| 飞书账号 | 教务 | 填了才能在群卡片里 @ 老师 |
| 课表名 | 教务 | 课表「老师」列的写法和姓名不同时才填（如 `Jack Hou`）。**刘峥在课表里没找到对应写法，请核对** |
| 在职 | 教务 | 不勾不提醒 |
| 手写寄语 | 教务（选填） | 填了就用它，不调 AI |
| AI 寄语、今年课节 / 学生 / 课时 | 系统 | 生日当天写入，教务可改 |
| 问卷已发年份、祝福已发年份 | 系统 | 防重复发送；想重发就清空 |

祝福表的「隐藏」只给教务用：勾上后这条不在网页上显示。

祝福表的「老师」应使用文本字段。飞书的引用选项（动态单选）不支持链接预填，会导致老师为空且必填项无法隐藏，见[官方说明](https://www.feishu.cn/hc/en-US/articles/763023425825-prefill-default-values-for-base-forms)。2026-10-15 排查发现引用单选导致预填失败；OpenAPI 返回 `800080212 unsafe_operation_blocked`，禁止直接转换动态选项字段。随后业务方在网页中手动改为文本，已通过 API 确认表字段和表单题目均为文本。转换后原有一条演示祝福的老师姓名为空，已按 `data/local/teacher-birthday/` 中的备份补回，核对全部已有记录与备份一致；线上生日页面接口返回 200，演示祝福正常显示。原有 `prefill_老师` 和 `hide_老师` 链接无需更换，浏览器中的预填及实际提交仍待验证。建表脚本只负责新建文本主字段，不会修正已有同名字段的类型。

2026-10-15 按业务要求取消生日祝福表的「年份」字段，改用「祝福时间」（`fld9IRVG2A`）。该日期字段默认值为「新增记录的创建时间」，在问卷中隐藏，填写者无需填写时间或年度。链接只保留 `prefill_老师` 和 `hide_老师`；建表脚本不会重建「年份」。老师档案里的「问卷已发年份」「祝福已发年份」仍用于每年防重复发送，网页 token 的年份仍用于链接签名和落款。

提醒计数、AI 寄语和网页按老师及祝福时间读取：每次收集周期从生日前 3 天的上海时间 00:00 起，到次年收集开始前结束，包含生日之后补交的祝福，也能处理跨年生日；没填生日时按自然年。其他周期、缺时间或勾选隐藏的祝福不展示。

该调整已部署到 `birthday-api`，徐翰超收到的汤朔测试卡片已原地更新链接并通过消息读取接口核对。移除年份前已确认祝福表为空；移除后，飞书表单无年份题目，线上汤朔页面接口返回 200。21 项测试与生产构建通过。

## 每天的流程

云函数 `birthday-api` 的定时触发器 `daily-9am` 每天 09:00（上海）运行：

1. 生日在 3 天内（含当天）、今年还没发过问卷的老师：向 `BIRTHDAY_ACADEMIC_CHAT_ID` 指定的教务群发送提醒，卡片带预填问卷链接和已收到条数。上线当天如果有人 3 天内过生日，会当天补发。
2. 今天生日、今年还没发过祝福的老师：统计过去 365 天的课表（有单价、时长 > 0、非临时取消），生成 AI 寄语，然后往 `BIRTHDAY_GROUP_CHAT_ID` 群发卡片并 @ 老师。
3. 发送成功后才写「已发年份」；某位老师失败不影响其他人。问卷第二天会重发；群卡片在生日后 2 天内补发（标题写明生日日期），再晚就不发了，可以手动演练 `celebrate` 补救。课表统计或 AI 失败都不会挡住群卡片。

网页每次打开都实时读祝福，生日当天之后补交的祝福也会出现。附件用飞书临时下载链接（24 小时有效），每次打开重新获取。

## 测试与上线

当前为业务指定的正式群配置：`BIRTHDAY_ACADEMIC_CHAT_ID` 为「教务群 - 生日」`oc_ee5597e67ae6a33dfffdb4358b1ecd90`；`BIRTHDAY_GROUP_CHAT_ID` 为「菁仕教育大群」`oc_b29eb8916144f9b64eb3f4e2c23a8664`。**演练命令也会向这些群发送消息**；下文私信徐翰超及「生日通知测试」群的描述是切换前的历史验证记录。

2026-10-15 已复用 `src/server/service.ts` 的 `rehearse(..., "ask")` 业务逻辑，由「课表分析」向徐翰超私信发送一次测试提醒：在内存中模拟汤朔老师于 2026-10-18 生日（提前 3 天），卡片标注「测试演练」，链接预填并隐藏老师「汤朔」和年份「2026」。本次未调用云端定时器、未发群卡片、未写老师的生日或已发年份；汤朔真实生日字段当时仍为空，自动任务需补齐后才能触发。

演练初期曾补回祝福表「年份」字段，随后按业务要求取消，当前逻辑见上文；刚才发送的测试卡片链接同步改为只预填老师。发送成功回执保存在本地 `outputs/teacher-birthday/2026-10-15/`；尚未代替填写者提交祝福或验证手机页面。

后续演练改用徐翰超：老师表新增 `reczz28NcTwyJRXs` 演示档案，生日与入职年份按本人提供的信息填写，入职月日用 1 月 1 日演示；学历和教学经历均标注演示，照片使用本人飞书头像。该记录「在职」未勾选，不参与定时提醒，仍可手动演练。祝福表新增一条明确标注「流程测试示例」的祝福，并已确认未手填时间时平台自动写入「祝福时间」。真实输入与头像仅保存在 `data/local/teacher-birthday/`，发送与页面验证产物在 `outputs/teacher-birthday/2026-10-15/`。

自动祝福时间分期逻辑已部署到云函数，22 项测试及生产构建通过；徐翰超新版演练提醒已私信发送，线上页面接口和头像下载均验证成功，Chrome 已确认姓名、本人头像、演示祝福和手写信笺可见。本次未发群卡片，也未写老师的已发年份。

演练（不看日期、不写已发年份、可以反复跑）：

```bash
npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 ask        # 教务群问卷提醒
npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 celebrate  # 群卡片 + AI 寄语，返回网页链接
npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 all
```

补跑某一天（**会真的发送并写年份**）：`tcb fn invoke birthday-api -e jingshi-test-d5gp401i44a0fa7a7 --params '{"action":"daily","today":"2026-10-12"}'`。

配置群：`server.env` 中设置 `BIRTHDAY_ACADEMIC_CHAT_ID`（提前三天收集提醒）和 `BIRTHDAY_GROUP_CHAT_ID`（生日当天祝福），确认「课表分析」在两群内，然后 `npm run deploy:functions -w @jingshi/teacher-birthday`。不再使用教务个人 open_id。

## AI 寄语

OpenAI 兼容接口，`server.env` 的 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`。现在用 DeepSeek 官方（`https://api.deepseek.com`、`deepseek-chat`），每位老师每年一次，约 300 token。CloudBase 自带的大模型网关在本环境返回 `EXCEED_TOKEN_QUOTA_LIMIT`（2026-10-09，套餐资源点不抵扣大模型），所以没用。调用失败时自动用模板寄语，群消息照发。

## 结构

```text
src/domain/      纯函数：日期规则、飞书字段解析、课表统计、寄语提示词与模板、飞书卡片、网页数据形状
src/server/      service.ts（每日任务 / 演练 / 网页数据，飞书 IO 注入）、token.ts、ai.ts
functions/       birthday-api 云函数入口（定时 + 调用 + HTTP /birthday-api/page）
src/web/         网页：main.ts 编排、scene.ts（three.js 派对场景，镜头随滚动移动）、cards.ts、styles.css
scripts/         setup-feishu.ts（建表）、deploy-function.mjs、rehearse.mjs
```

飞书客户端复用 `apps/course-feedback-tracker/src/server/feishu/client.ts`（esbuild 打包进函数）。

## 命令

```bash
npm test -w @jingshi/teacher-birthday
npm run dev -w @jingshi/teacher-birthday            # http://localhost:4179/birthday/?demo=6
npm run deploy:functions -w @jingshi/teacher-birthday   # 需要 server.env（见 server.env.example）
npm run deploy:web -w @jingshi/teacher-birthday
```

HTTP 路由 `app.jsjy.asia/birthday-api → 云函数 birthday-api` 已用 `tcb routes add` 加好；网页在静态托管 `/birthday/`。

场景亮度的调节点在 `src/web/scene.ts`：主光 `SpotLight` 强度、`toneMappingExposure`、泛光阈值（`UnrealBloomPass` 第 4 个参数，高于奶油高光才不会整块发白）。
