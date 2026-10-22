# 学生自助取消课程

和月度反馈共用这个 CloudBase 环境和飞书适配代码，但业务独立：独立云函数 `cancel-api`、独立飞书应用（机器人「课表分析」）、独立页面 `/cancel/`。

## 流程

1. 教务在取消课程管理页（`https://app.jsjy.asia/cancellations/`，教务账号登录）搜索学生、复制链接；新学生点「为新学生生成链接」。链接形如 `https://app.jsjy.asia/cancel/?t=<token>`，存 `cancel_links`，可用 `npm run cancel-links -- --revoke 张三` 停用重发。同一页列出最近的取消记录。
2. 学生打开选课页，只看到自己**正在上和接下来 14 天**的课，点课时实时提示收费档位。多人共用一条课表记录的课不能自助取消。
3. 确认后 `POST /cancel-api/intent` 生成**一次性取消编号**（30 分钟有效，存 `cancel_intents`），跳转飞书问卷，编号预填并隐藏。
4. 学生在问卷里选原因（个人原因 / 病假，可传证明）提交。飞书「多维表格记录变更」事件推到 `POST /cancel-api/webhooks/feishu`。
5. 云函数回读申请记录和课表，核验编号未用、未过期、课属于该学生、未下课、未取消，按**提交时间**定档写课表「临时取消」，在申请表「处理结果」留痕，机器人私聊老师（「老师-日历」人员字段）并发教务群。任何一步不通过都不写课表，只在教务群报异常。

通知标题同时显示授课老师和学生，正文首行加粗老师姓名；姓名优先取课表「老师」，为空时取「老师-日历」姓名，两者都空则明确显示「老师未填写」。群卡片有飞书账号时 @ 老师。私聊和群卡片都提供「查看本节课课表」主按钮，基于 `CANCEL_SCHEDULE_URL` 保留指定视图并定位被取消的记录，沿用课表访问权限；没有账号或私聊失败时提示教务手动通知对应老师。

## 正式配置（2026-10-15）

- 课表：`Xb34bXSVRaQk7ysfAQScPZp5nPh / tblWoTVtU4lqJoes`；CTA 视图 `vews45HuxI`。
- 学员信息：`tblQGkH5DweXpOW8`。
- 取消申请：同一正式 Base 的 `tblaafi7bJvZbgWO`；问卷 `vewfEPg5i8`，对外开放填写，隐藏「处理结果」，病假证明只在选病假时展示。
- 通知群：**菁仕教育大群**（`oc_b29eb8916144f9b64eb3f4e2c23a8664`），替代原测试群。
- 「课表分析」应用已有正式 Base 的管理权限，并订阅该 Base 的记录变更事件（订阅需要管理权限）。
- 正式学生链接重新生成 224 个，211 个测试链接已停用。教务从 `/cancellations/` 复制新链接；本地导出为 `outputs/lesson-cancellation/cancel-links.csv`。
- 字段定义备份：`outputs/lesson-cancellation/production-fields-before.json`；切换记录：`outputs/lesson-cancellation/production-cutover.json`。
- 验证：正式学生链接可读正式课程，旧链接返回 403；两条现有免费/病假记录金额为 0 且有日历前缀；新群已收到 CTA 上线验证卡片；已处理的校验申请 `reczz28NLo3Rptrc` 经模拟回调返回跳过，未修改真实课表。未做真实课程取消实测，自动事件投递尚未取得日志证据，问卷浏览器预览被权限策略拒绝。

| 提交时距上课 | 写入「临时取消」 |
|---|---|
| 已开课、未下课 | 0h-70% |
| 2 小时以内 | 2h-50% |
| 2–6 小时 | 6h-30% |
| 6 小时以上 | 提前取消-0% |
| 病假 | 学生病假-0%（默认不收费，进入问题检查） |

规则代码：`src/cancellation/rules.ts`；流程：`src/cancellation/service.ts`；飞书字段名：`src/server/cancellation/feishu.ts`。

## 部署

```bash
cp cancel.env.example cancel.env   # 填飞书应用密钥、课表/申请表、表单链接、教务群
tcb db execute --sql "$(cat migrations/202610090002_lesson_cancellation.sql)"
tcb db execute --sql "$(cat migrations/202610100001_cancel_intent_lesson.sql)"
npm run deploy:cancel-api          # 打包 + 部署 cancel-api（CLOUDBASE_* 复用 server.env）
npm run deploy:cancel-page         # 学生选课页 → 静态托管 /cancel/
npm run deploy:cancellations       # 教务管理页 → 静态托管 /cancellations/（cancellations.html + vite.cancellations.config.ts）
```

HTTP 访问服务路由：`app.jsjy.asia/cancel-api → 云函数 cancel-api`（`tcb routes add` 已加）。
运维补处理某条申请：`tcb fn invoke cancel-api --params '{"action":"process","recordId":"rec..."}'`。

## 切换到主课表

学生链接按学员信息表的记录 ID 绑定，不能仅凭测试表和主表的记录 ID 相同就沿用测试身份；切换时先备份并停用旧链接、终止未处理的测试申请，再生成正式链接。日常新增学生仍用 `npm run cancel-links`，会保留已有正式链接。修改 `cancel.env` 的 `CANCEL_SCHEDULE_*`（含 CTA 用 `CANCEL_SCHEDULE_URL`）/ `CANCEL_REQUEST_*` / `CANCEL_FORM_URL` / `CANCEL_GROUP_CHAT_ID` 后重新部署，并确认新 Base 已订阅事件。

## 课表字段改动（正式课表已完成）

- 「临时取消」单选新增 `提前取消-0%`、`学生病假-0%`。
- 「课程总价格」公式：这两个选项算 0。
- 「学员课程ID」「老师课程ID」公式：前面统一加请假前缀（`请假 70%｜`…`请假 0%｜`、病假为 `病假｜`），老师日历标题因此也能看到取消。
- 新建「取消申请」表（取消编号 / 取消原因 / 补充说明 / 病假证明 / 处理结果 / 提交时间）和表单视图「学生取消课程问卷」，任何人可填，「处理结果」在表单中隐藏。
- 正式字段定义备份为 `outputs/lesson-cancellation/production-fields-before.json`；早期测试备份为 `outputs/lesson-cancellation/test-base-schedule-fields-before.json`。

飞书应用需要的权限：`bitable:app`（读写多维表格）、`im:message:send_as_bot`（发消息）、`docs:event:subscribe`（订阅多维表格记录变更事件）；应用「可用范围」要包含所有老师，否则私聊发不出去。
