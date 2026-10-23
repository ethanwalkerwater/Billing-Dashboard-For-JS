# 菁仕课堂（classroom-recorder）设计与接口约定

UI / UX 唯一依据：`docs/MVP.html`（老师端，含「随时录制」三步演示）与 `docs/classroom-report.html`（完整报告网页）。
产品规则依据：`docs/课堂录制.html`。云端流程参考 jingshi-vocal v1.3（腾讯云录音文件识别 + 大模型）。

## 选型

- **桌面端：Tauri 2**（一套代码出 macOS `.dmg` 与 Windows `.msi/.exe`，安装包约 10 MB）。
  - 录音、切段、上传、课表轮询、状态机全部在 **Rust** 里跑，窗口关掉 / 隐藏都不影响录音；
    规避了方案文档里担心的「Mac WebView 后台录音受限」。
  - 录音：`cpal` 采集 → 单声道 → 线性重采样 16 kHz → `mp3lame-encoder` 32 kbps MP3，每 30 秒一段（约 120 KB，一小时约 14 MB）。
    MP3 帧可直接按字节拼接，云端不需要 ffmpeg。
  - Web 层（Vite + 原生 TS，无框架）只负责渲染三个窗口：`main`（主窗口）、`pill`（顶部胶囊）、`toast`（右上角通知）。
  - 菜单栏 / 托盘用 Tauri 原生托盘菜单；macOS 菜单栏标题显示录制计时。
- **云端：CloudBase（环境 `jingshi-test-d5gp401i44a0fa7a7`）**
  - HTTP 云函数 `classroom-api`（路径 `https://app.jsjy.asia/classroom-api`）+ 腾讯云转写完成回调推进处理流水线，每 30 分钟定时触发兜底。
  - PostgreSQL 表 `classroom_lessons`、`classroom_segments`、`classroom_sessions`、`classroom_auth`（本环境没有文档型数据库）；Storage 私有桶 `classroom` 放录音分段与合并后的 MP3。
  - 静态托管 `https://app.jsjy.asia/classroom/report.html?t=<token>` 承载完整报告。
- **登录：飞书网页授权**（应用 = 机器人「课表分析」`cli_a93a4faca0f8dcb6`，与老师档案「飞书账号」同一应用，open_id 一致）。

## 登录流程（无需 deep link / 本地端口）

1. App `GET /auth/start` → `{ state, url }`，用系统浏览器打开 `url`（飞书授权页，redirect_uri = `/classroom-api/auth/callback`）。
2. 飞书回调 `/auth/callback?code&state`：云函数换 user_access_token → 取 open_id/姓名 → 在老师档案表按「飞书账号」找老师（课表名优先，否则姓名）→ 生成 session token 写库，页面显示「登录成功，可以回到菁仕课堂」。
3. App 每 2 秒 `GET /auth/poll?state=` 直到拿到 `{ token, teacher }`（state 10 分钟过期）。token 存本机 app 数据目录。

## HTTP 接口（除 auth/* 与 report 外均需 `Authorization: Bearer <token>`）

所有响应 JSON；错误 `{ error: "CODE", message }`，401 = 需要重新登录。

| 方法 路径 | 说明 |
|---|---|
| `GET /auth/start` | `{ state, url }` |
| `GET /auth/callback?code&state` | HTML 页面 |
| `GET /auth/poll?state` | 202 `{ pending: true }` / 200 `{ token, teacher: { name } }` |
| `GET /me` | `{ teacher: { name } }` |
| `GET /lessons` | 这位老师最近 7 天 + 明天的课，见下方 `Lesson` |
| `POST /lessons/:id/segments/:seq` | body = 原始 MP3 字节（HTTP 访问层以 base64 传入），header `x-sha256`；重复上传覆盖 → `{ ok: true }` |
| `POST /lessons/:id/finish` | `{ startedAt, endedAt, segments: [{ seq, sha256, bytes }], topic?, kind? }`（ISO 时间；`topic` / `kind = adhoc | meeting` 只对随时录制有效）→ `{ missing: number[] }`；为空即开始处理 |
| `PUT /lessons/:id/summary` | `{ text }` 保存老师改过的总结 |
| `POST /lessons/:id/copied` | 标记已复制 |
| `POST /lessons/:id/discard` | 老师在 App 里删了这节课：没出报告的不再处理（标失败、次数用满） |
| `GET /report?t=<token>` | 公开，报告网页数据 `ReportData` |

后台接口（`/admin/*`，`Authorization: Bearer <后台 token>`；`GET /admin/login` 跳飞书授权，回调后带 `#token=` 跳回 `/classroom/admin/`（旧地址 admin.html 自动跳过去））：

| 方法 路径 | 说明 |
|---|---|
| `GET /admin/lessons?q&stage&kind&teacher&student&before` | 课程列表，按上课时间倒序每页 50；`stage` = done / processing / recording / failed；`kind` = lesson（含随时录制的课）/ meeting，`teacher` / `student` 精确匹配；时长用 `audioSec`（合并时按分段字节数算的实际录音秒数） |
| `GET /admin/people` | 表头筛选候选：视图 `classroom_lesson_people`（老师 × 学生去重） |
| `GET /admin/lessons/:id` | 详情：转写、总结、`audioUrl`（6 小时签名链接）、`reportUrl` |
| `GET /admin/me` | `{name, role}`；role = admin（超级管理员）/ teacher。老师调用的课程类接口只返回 `teacherOpenId` 是自己的，提示词、试生成、管理员名单返回 403 |
| `GET /admin/report?t=` · `PUT /admin/report?t=` | 报告编辑：GET 取原文和 `rev`（报告 JSON 的 sha256）；PUT `{rev, report}` 只合并文字（`applyReportEdits`：必填项清空保留原文，列表项清空即删除，知识点改名同步时间轴），版本对不上 409；会议同时重写纪要文字版 |
| `GET /admin/admins` · `PUT/DELETE /admin/admins/:openId` | 超级管理员名单（创建者来自 `ADMIN_OPEN_IDS`，不能移除）；候选 = 登录过 App 或后台的人 |
| `PUT /admin/lessons/:id/summary` | 后台改家长总结 / 会议纪要文字（页面上直接改、划词全部替换，停手 1 秒自动保存），写 `editedSummary`，和 App 里改的是同一份；body `{text, base}`，base = 当前文字的 sha256，对不上 409 |
| 请求头 `x-view-as: <open_id>` | 超级管理员切到某位老师的视角：之后的请求按这位老师的权限（只看、只改他的课） |
| `PUT /admin/lessons/:id/transcript` | 后台改转写（错字、划词全部替换、说话人改名）。body `{transcript, base}`，`base` 是打开编辑时转写的 sha256，对不上返回 409；第一次改时机器原文存进 `rawTranscript`；会议按新名字重算发言占比 |
| `POST /admin/lessons/:id/retry` | 失败的课把 `attempts` 清零并立刻重跑 |
| `POST /asr/callback?lesson=` | 腾讯云录音识别转完的回调（不鉴权，只按编号推进，实际状态以 DescribeTaskStatus 为准） |
| `GET /admin/prompts` | 最近 30 个版本，第一个是线上 |
| `POST /admin/prompts` | `{ prompts, base }`，`base` 不是当前线上版本号时 409 |
| `POST /admin/preview` | `{ prompts, lessonId }` 或 `{ prompts, transcript }` → `{ parentSummary, reportData }`，不写库 |
| `POST /admin/uploads/:uid/:n`、`POST /admin/uploads/:uid/finish`、`GET /admin/asr/:taskId` | 测试音频分块上传（每块 ≤ 2 MB）→ 拼回 → 腾讯云识别 → 轮询转写 |

学情报告预览复用 `report.html`：后台把 `reportData` 写进同域 localStorage（`classroom-preview:draft|live`），用 `report.html#preview=draft` 打开。

随时录制：课程编号 `adhoc-<16 位 hex>` 由 App 生成，`:id` 同样接受。第一次上传分段时按当前老师建档（不查课表），finish 时写入主题、类型和真实起止时间。
`kind = meeting` 的整理成结构化会议纪要（`MeetingReport`：板块 → 议题、决定、待办、待跟进、发言占比；提示词是后台第四栏「会议纪要」，不套通用规则），纯文本【决定】【待办】【待跟进】由程序从同一份数据拼出，纪要网页同样走 `report.html?t=`（版式见 `docs/meeting-report.html`）；不判断老师 / 学生，不出家长总结和学情报告；`adhoc` 与课表课一样出家长总结和学情报告。
录音（分段 + merged.mp3）保留 30 天，转写入库后先删分段；过期后删 merged.mp3、记 `audioDeletedAt`，转写和总结一直保留。

```ts
type LessonStatus = "upcoming" | "recording" | "processing" | "done" | "cancelled";
interface Lesson {
  id: string;          // 飞书课表 record_id
  date: string;        // "2026-10-15"（上海时区）
  start: string;       // "16:00"
  end: string;         // "17:00"
  startAt: number;     // epoch ms
  endAt: number;
  title: string;       // "IG 物理 · 小雨"  = 课程类型 · 学生
  topic: string;       // 云端整理出的主题 · 上课地点，可为空
  status: LessonStatus;// 服务端视角；recording = 已收到分段但未 finish
  copied: boolean;
  summary?: string;    // done 时给出（老师改过的版本优先）
  reportUrl?: string;  // done 时给出
  kind?: "adhoc" | "meeting"; // 随时录制；课表课没有
  needsName?: boolean; // 只在本机快照：随时录制已结束、等老师填主题
}
```

云端处理状态（`classroom_lessons.stage`）：`recording → queued → transcribing → summarizing → done | failed`，对外统一映射为 `processing / done`。
下课 2 小时后仍缺段：用已有分段出报告，并在报告中注明「录音缺失约 X 分钟」。

## Rust ↔ Web 约定（Tauri）

Rust 是唯一状态源，每次状态变化 emit 全局事件 `app-state`（完整快照），声波电平单独 emit `level`（约 8 Hz，0–1）。
Web 端启动时 `invoke("get_state")` 拿首帧。
托盘「设置…」会打开主窗口并 emit 事件 `open-settings`（无载荷），主窗口收到后打开设置面板。
`selectedLessonId` 只随一次快照发出（下一次快照即回到 null），Web 收到非空值时选中即可。

```ts
type RecMode = "idle" | "pre" | "recording" | "confirm" | "warn" | "ending" | "processing" | "naming" | "gone"; // naming = 随时录制刚结束，胶囊变成填主题卡片
interface AppState {
  teacher: { name: string } | null;       // null = 未登录，main 窗口显示登录页
  loggingIn: boolean;
  lessons: Lesson[];                       // 已合并本机录制状态
  rec: {
    mode: RecMode;
    lessonId: string | null;               // 胶囊/菜单栏所指的那节课（pre 时是下一节）
    sec: number;                           // 已录秒数
    endLeft: number;                       // ending 模式下剩余秒数
    autoStopAt: string;                    // "17:10"
    autoStartAt: string;                   // "15:57"（pre 模式）
    savedSegments: number;
    uploadedSegments: number;
    online: boolean;
  };
  mics: string[]; mic: string;             // 当前麦克风
  autostart: boolean;
  fab: boolean;                            // 设置里「悬浮录制按钮」开着
  toast: { lessonId: string; title: string; body: string } | null;
  selectedLessonId: string | null;         // 托盘/通知「查看」时让主窗口选中
}
```

Commands（`invoke(name, args)`）：
`get_state`、`login`、`logout`、`start_recording { lessonId }`、`request_stop`（→ confirm）、`resume_recording`、
`end_recording`、`extend_recording`（+15 分钟）、`switch_mic { name }`、`save_summary { lessonId, text }`、
`copy_summary { lessonId, text }`（写剪贴板 + 保存 + 标记已复制）、`open_report { lessonId }`（系统浏览器）、
`open_main { lessonId? }`、`hide_toast`、`start_adhoc`（随时录制）、`name_adhoc { lessonId, topic, kind }`、`set_fab { enabled }`、`resize_fab { width, height }`、`set_autostart { enabled }`、`resize_pill { width, height }`、`start_level_preview` / `stop_level_preview`（设置页试音）。

## 录制规则（来自产品方案）

- 随时录制：屏幕右侧悬浮按钮（`fab` 窗口，4 秒不碰淡成 25% 透明，悬停恢复，可拖动，设置里可关）或菜单栏「随时录制」，点一下开录，不需要课表、不参与自动开录，最长 3 小时。
  结束后胶囊（和主窗口详情）请老师填主题、选「课程 / 会议」，分段照常上传，填好才提交 finish；10 分钟不填或又开始新的录制，按「课程 · 随时录制 HH:MM」处理。连堂的课到点自动开录时会先停掉随时录制。

- 拉课表：启动、登录、打开主窗口（10 分钟内不重复）、手动刷新、每天北京时间 7:00；不轮询报告状态（报告好了云端飞书私信老师）。老师可在 App 里删除某节课（只本机隐藏，录音丢弃并通知云端放弃）。开课前 10 分钟 → `pre`（胶囊出现，试音电平）；开课前 3 分钟自动开录；可提前最多 30 分钟手动开录。
- 课表下课后 10 分钟自动停；下课后第 5 分钟进入 `ending` 倒计时，可「再录 15 分钟」/「现在停止」。手动结束需二次确认（`confirm`）。
- 开录 2 分钟仍几乎无声 → `warn`，给出可切换的麦克风；录音不中断。麦克风断开 → 自动切到系统默认。
- 「临时取消」的课不自动录。连堂：下一节自动开录时间点先停上一节再开下一节。
- 录制中阻止系统睡眠；关窗只隐藏到菜单栏 / 托盘；App 崩溃重启后若仍在上课时间内自动续录，已录分段继续上传。
- 分段先落盘（app 数据目录 `recordings/<lessonId>/<seq>.mp3` + `lesson.json` 上传记录）再上传；失败退避 1s→2s→…→5min；云端确认后本机保留 7 天。
