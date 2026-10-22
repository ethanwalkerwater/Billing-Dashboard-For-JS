# 菁仕课堂（classroom-recorder）

老师在自己的 Mac / Windows 电脑上装「菁仕课堂」，用飞书登录后，App 按飞书课表自动录课、边录边传；下课后云端把录音转成文字，生成一段可直接发给家长的课堂总结和一份完整的课堂学情报告，再用飞书私信通知老师。

- 设计与接口约定：[`docs/design.md`](docs/design.md)；产品方案：[`../../docs/课堂录制.html`](../../docs/课堂录制.html)；报告网页原型：[`../../docs/classroom-report.html`](../../docs/classroom-report.html)。
- 随时录制：屏幕右侧的悬浮按钮（几秒不碰会淡下去）或菜单栏「随时录制」，不需要课表；结束时填主题、选「课程」（出家长总结 + 学情报告）或「会议」（出会议纪要）。
- 后台：`https://app.jsjy.asia/classroom/admin.html`，飞书登录，只放行 `ADMIN_OPEN_IDS` 里的人。按课程听 / 下载录音、看 / 下载转写、看家长总结和学情报告；改提示词，用已有课程、上传音频或粘贴转写试生成，和线上版本并排对比，确认后「应用到全部老师」。
- 完整报告：`https://app.jsjy.asia/classroom/report.html?t=<token>`，不需要登录，靠 32 位随机 token 防猜。「下载 PDF」调用浏览器打印，另存的文件名为 `学生_课程_日期_课堂学情报告`。

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
       → summarizing → 大模型（超过 12000 字先分段摘要再汇总）
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
| `classroom_lessons` | 飞书课表 record_id | 老师 openId、学生、课程、时间；`stage`、`finish`、`asrTaskId`、`transcript`、`summary` / `editedSummary`、`report`、`reportToken`、`gapMinutes`、`audioSec`（实际录音秒数）、`copied`、`attempts` / `error`、`lockedUntil`（处理租约） |
| `classroom_segments` | (`lessonId`, `seq`) | 每段的 sha256、字节数、Storage 对象名 |
| `classroom_prompts` | `version` | 后台保存的提示词（通用规则 / 家长总结 / 学情报告 / 会议纪要四段；早于会议纪要的版本该列为空，读取时用默认），版本号最大的一行是线上；一行都没有时用 `logic.ts` 的 `DEFAULT_PROMPTS`（版本 0）。课程的 `promptVersion` 记生成时用的版本 |
| `classroom_admin_sessions` | token 的 sha256 | 后台登录，30 天过期 |

Storage 桶 `classroom`（私有）：分段 `{lessonId}/{seq}.mp3`（转写入库后删除）与合并后的 `{lessonId}/merged.mp3`（保留 30 天后删除，转写和总结一直保留），后台测试上传的音频在 `preview/{随机 ID}/audio`（分块拼好即删，拼好的音频不自动清理），腾讯云识别用 6 小时签名链接（`fullSignedURL`）下载。

处理失败会记 `stage = failed`、`failedStage`、`error`，下一分钟从失败的那一步重试，累计 3 次后停止并私信老师。下课 2 小时后仍缺分段，就用已有分段出报告，报告页注明「录音缺失约 X 分钟」。某节课要重跑：把 `stage` 改回 `queued`（或 `summarizing`）、`attempts` 改为 0，再 `tcb fn invoke classroom-api --params '{"action":"tick","lessonId":"rec…"}'`。

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
npm run deploy:web -w @jingshi/classroom-recorder         # 报告网页 + 后台 → 静态托管 /classroom

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
