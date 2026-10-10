# 老师生日祝福（teacher-birthday）

教务在飞书维护老师档案。老师生日前 3 天，系统私信教务一份预填好老师姓名的祝福问卷，由教务转给学生和同事；生日当天 9:00，系统往老师群发一张卡片，点开是这位老师的专属生日网页：一场 3D 生日派对（精致蛋糕、气球、彩旗、串灯、彩纸礼炮），往下滑镜头连续移动，依次看到拍立得祝福卡片墙和 AI 寄语。

- 网页：`https://app.jsjy.asia/birthday/?t=<token>`。每位老师每年一个链接，不需要登录，靠 token 防猜；本地没有 `t` 参数时显示演示数据（`?demo=0|6|12`）。
- 设计与口径：[`specs/teacher-birthday/design.md`](../../specs/teacher-birthday/design.md)；实施计划：[`tasks.md`](../../specs/teacher-birthday/tasks.md)。

## 飞书

都在 wiki「老师数据主表」这个多维表格里（`JfncbHflsaXCKTsTyjycnBtYnsf`），机器人是「课表分析」（`cli_a93a4faca0f8dcb6`）。

| 用途 | 地址 |
|---|---|
| 老师档案（教务维护） | 「数据表」`tbl04lXBPk2YkIif` |
| 祝福问卷（教务转发；链接由系统预填老师和年份） | <https://ccntnl19k0y3.feishu.cn/share/base/form/shrcnR5dhvcfKOlxDninRSmsmeb> |
| 收到的祝福 | 「生日祝福」`tblfHGKqIDCCO1M2` |

**字段不要改名**，程序按字段名读写。建表脚本 `scripts/setup-feishu.ts` 可以重复运行，只补缺失的字段，不删也不改已有字段。

| 老师表字段 | 谁填 | 说明 |
|---|---|---|
| 姓名、性别、主学科、学历信息、教学特点、可授课课程、照片 | 已从官网「名师团队」22 位导入 | 新老师由教务补 |
| 生日、入职时间 | 教务 | 公历；网页不显示年份和年龄。入职时间决定蜡烛数和「在菁仕的第 N 天」 |
| 手机、微信 | 教务 | 只存档，不上网页 |
| 飞书账号 | 教务 | 填了才能在群卡片里 @ 老师 |
| 课表名 | 教务 | 课表「老师」列的写法和姓名不同时才填（如 `Jack Hou`）。**刘峥在课表里没找到对应写法，请核对** |
| 在职 | 教务 | 不勾不提醒 |
| 手写寄语 | 教务（选填） | 填了就用它，不调 AI |
| AI 寄语、今年课节 / 学生 / 课时 | 系统 | 生日当天写入，教务可改 |
| 问卷已发年份、祝福已发年份 | 系统 | 防重复发送；想重发就清空 |

祝福表的「隐藏」只给教务用：勾上后这条不在网页上显示。

## 每天的流程

云函数 `birthday-api` 的定时触发器 `daily-9am` 每天 09:00（上海）运行：

1. 生日在 3 天内（含当天）、今年还没发过问卷的老师：私信 `BIRTHDAY_ACADEMIC_OPEN_IDS` 里的人，卡片带预填问卷链接和已收到条数。上线当天如果有人 3 天内过生日，会当天补发。
2. 今天生日、今年还没发过祝福的老师：统计过去 365 天的课表（有单价、时长 > 0、非临时取消），生成 AI 寄语，然后往 `BIRTHDAY_GROUP_CHAT_ID` 群发卡片并 @ 老师。
3. 发送成功后才写「已发年份」；某位老师失败不影响其他人。问卷第二天会重发；群卡片在生日后 2 天内补发（标题写明生日日期），再晚就不发了，可以手动演练 `celebrate` 补救。课表统计或 AI 失败都不会挡住群卡片。

网页每次打开都实时读祝福，生日当天之后补交的祝福也会出现。附件用飞书临时下载链接（24 小时有效），每次打开重新获取。

## 测试与上线

当前是**测试配置**：私信只发徐翰超，群消息只发「生日通知测试」群（`oc_0fb80402fe51d4490132e94554af137d`）。

演练（不看日期、不写已发年份、可以反复跑）：

```bash
npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 ask        # 私信问卷
npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 celebrate  # 群卡片 + AI 寄语，返回网页链接
npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 all
```

补跑某一天（**会真的发送并写年份**）：`tcb fn invoke birthday-api -e jingshi-test-d5gp401i44a0fa7a7 --params '{"action":"daily","today":"2026-10-12"}'`。

上线：`server.env` 里把 `BIRTHDAY_ACADEMIC_OPEN_IDS` 换成华心晨、Tinko 的 open_id（逗号分隔，用「课表分析」机器人的身份查），`BIRTHDAY_GROUP_CHAT_ID` 换成正式老师群（先把「课表分析」拉进群），然后 `npm run deploy:functions -w @jingshi/teacher-birthday`。

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
