# Implementation Plan

> 架构调整（2026-09-17，已与业务方确认）：测试环境的 CloudBase 数据库是 PostgreSQL 17，
> 因此改为「前端经 PostgREST + RLS 直连数据库 + 单个云函数 `feedback-api`」，
> 二维码和批量 ZIP 在浏览器生成，不再使用私有云存储、sharp、archiver 和 QR worker。
> 原三函数 + 云存储方案见 design.md 第 3–4 节，已作废。

- [x] 1. 创建独立应用骨架与领域内核
  - 新增 `apps/course-feedback-tracker` workspace、TypeScript/Vite/React 配置和测试入口
  - 实现收集月份到上一个课程月份的转换、上海时区范围、课程过滤、学生老师分组和稳定任务 ID
  - 实现四状态迁移、飞书预填链接和公开 token 工具
  - _Requirement: R1, R2, R3, R8_

- [x] 2. 实现飞书服务端适配器
  - 分页读取课表、学生关联表、答卷表和字段选项
  - 实现下拉选项只追加不删除、字段结构校验、限流重试和脱敏错误
  - 使用 mock fixture 完成契约测试，不把真实 CSV 或 Secret 加入仓库
  - _Requirement: R1, R2, R4, R7_

- [x] 3. 实现 CloudBase 任务存储与审计
  - 两份 SQL migration 已应用到 `jingshi-test-d5gp401i44a0fa7a7`：6 张表、索引、唯一约束、RLS 策略
  - 状态审计改为数据库触发器 `feedback_tasks_status_audit`，前端和云函数都绕不过（已实测）
  - `RdbFeedbackTaskRepository` 经 PostgREST 读写，`task_id` upsert 保证月度同步幂等
  - _Requirement: R1, R3, R4, R7, R8_

- [x] 4. 实现 CloudBase 函数和权限边界
  - `feedback-api` 已部署，HTTP 访问服务路径 `/t` 与 `/webhooks` 已创建
  - `GET /t/:token` → 302 跳飞书预填问卷，已实测；无效 token 与不存在 token 返回同一页面
  - `POST /webhooks/feishu` challenge 与签名/解密校验已实测
  - 定时触发器每 5 分钟补偿对账；稳态下零写入
  - 管理接口校验 CloudBase 登录身份 + `feedback_admins` 白名单（已实测：CLI 无身份调用返回 401）
  - 云函数 `app.rdb()` 实测是 `anon` 角色，改用环境 API Key（`role=service_role`）自建 PostgREST 客户端
  - _Requirement: R1, R3, R4, R7, R8_

- [x] 5. 实现二维码生成与批量产物
  - 单张 1080×1440 PNG 与批量 ZIP 在浏览器用 canvas + JSZip 生成
  - 二维码编码短链接而非含姓名的飞书长链接；M 级纠错 + 4 模块静区
  - 部分失败时 ZIP 仍包含成功项并附「生成失败清单.csv」
  - 中文字体改用系统字体栈（苹方 / 微软雅黑），不依赖 Google Fonts（大陆常不可达）
  - _Requirement: R2, R8_

- [x] 6. 实现教务管理前端
  - 邮箱密码登录、双月份上下文、四状态统计与完成率、搜索 + 老师筛选
  - 统计与列表共用同一筛选结果，数字不会对不上
  - 批量标记已发 / 拒绝 / 退回未发；已有答卷的任务自动跳过并在提示里说明
  - 二维码抽屉：预览、单张下载、复制链接、打开问卷
  - 同步异常面板：已追加的问卷选项、课程类型待确认、未生成任务的记录、课表数据问题、异常答卷
  - 静态站点已部署
  - _Requirement: R2, R3, R4, R5, R7_

- [x] 7. 实现与老师反馈系统的衔接
  - 导出任务清单 CSV（当前筛选）、课表 CSV（课程月份）、反馈 CSV（收集月份）
  - 时间格式对齐 `apps/teacher-feedback/scripts/monthly_teacher_feedback.py` 的 `strptime` + `%Y-%m` 口径
  - `tests/export.test.ts` 锁死列名、时区和转义
  - 工作台底部提供前往反馈报表系统的入口和上传提示
  - _Requirement: R6_

- [ ] 8. 完成验证、文档和测试环境部署
  - [x] TypeScript 无错误；32 个单元/契约/兼容测试通过；前端与函数构建通过
  - [x] 函数与静态站点已部署到 `jingshi-test-d5gp401i44a0fa7a7`
  - [x] 已用真实课表样本（2026-05，1614 条）验证分组：279 份任务 / 113 学生 / 30 老师，
        异常记录从 288 条降到 12 条
  - [x] 已实测：扫码 302 预填、Webhook challenge、未登录 401、状态审计触发器
  - [x] README、环境变量说明、部署与 Secret 轮换说明
  - [x] 飞书 App Secret 已录入（完整 32 位；旧云函数配置里那份是被控制台表格截断的 24 位）
  - [x] 首批管理员 `edhudsonxu@gmail.com` 已创建并写入 `feedback_admins`，浏览器实测可登录
  - [x] **真实月度同步已跑通**：2026-09 收集月读 8594 条课表，生成 258 份任务 / 89 学生 / 32 老师；
        排除 378 条、待复核 61 条、数据有问题 55 条
  - [x] 真实二维码短链接实测 302 跳转，老师/学生/任务 ID 预填正确
  - [ ] **待办：飞书事件订阅** — 在开放平台配置回调地址
        `https://jingshi-test-d5gp401i44a0fa7a7-1300607705.ap-shanghai.app.tcloudbase.com/webhooks/feishu`，
        并把 Encrypt Key / Verification Token 写入 `server.env` 后重新部署
  - [ ] 事件订阅配好后：端到端走一遍学生扫码填写 → 任务状态自动变「已填写」
  - _Requirement: R1-R8_

## 踩过的坑（别再踩）

1. **多维表格关联字段是 `record_ids` 数组，不是 `id`。** 单元测试原来用的是 `lark-cli` 归一化后的
   `[{ id }]`，跟接口真实返回的 `[{ record_ids: [...], text_arr, table_id, type }]` 不一样，
   结果整月 258 份任务全部判成「缺少学生」，dry run 出 0 份。测试现在锁死真实形状。
2. **排除规则必须排在缺字段判断前面。** 请假、考试、例会这类记录本来就没有老师，
   先查缺字段会把每月近 300 条误报成「课表数据有问题」。
3. **云函数的 `app.rdb()` 是 `anon` 角色**，不是服务端角色。要用 API Key（`role=service_role`）。
4. **CloudBase HTTP 访问服务会剥掉服务路径前缀**，且 `requestContext` 里没有原始路径。
5. **`@cloudbase/js-sdk` 登录失败返回 `{ error }` 而不是 throw**，只写 try/catch 页面会一声不吭。
