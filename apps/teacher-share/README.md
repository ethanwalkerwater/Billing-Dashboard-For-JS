# 老师分享（teacher-share）

教务挑几位老师、写一个标题（如「雅思语培」）和一段介绍，生成一条链接发给家长。家长打开只看到这几位老师，不用在官网全部老师里找。

- 后台：<https://app.jsjy.asia/share/>（飞书登录，只有 `feedback_admins` 里 role 是 `admin` / `super` 的账号能用，和排课黑名单同一份名单；老师账号看到「只有教务能用」）
- 家长页：`https://jsjy.asia/s/<8 位编号>`，在官网仓库（`菁仕官网`：`src/app/s/[code]/page.tsx`、`src/data/shares.ts`）

## 口径

| 项 | 规则 |
|---|---|
| 能选的老师 | 官网的名师团队 + 菁仕严选，名单从官网 `/api/share-teachers` 读（随官网发版更新）。按姓名存，两批老师不重名 |
| 家长页内容 | 标题、介绍（按换行分段）、老师卡片（名师有照片和评分，严选是官网现有的「形象照准备中」卡片），点卡片进官网详情页，底部「预约试听」。带官网顶栏，不进搜索引擎 |
| 顺序 | 家长页按教务选的顺序，已选里可以前后挪 |
| 链接 | 不过期。改标题、介绍、老师后链接不变；停用后家长看到「这个链接已失效」，可以恢复 |
| 老师离职 | 官网删掉这位老师后，所有分享页里自动不显示；后台列表标「N 位已不在官网」 |
| 谁能改 | 所有教务能看、能改全部链接；两人同时改同一条，后保存的会被拦下（「别人刚改过」），刷新后再改 |

## 怎么串起来

```text
后台 /share/ ── callFunction share-api {list | save | set-active | refresh} ── teacher_shares（PostgreSQL，RLS 开、无 policy）
            └─ fetch 官网 /api/share-teachers（老师名单，公开数据）
保存 / 停用 → share-api POST 官网 /api/revalidate {"target":"shares"}（x-site-key）→ 官网作废分享页缓存

家长打开 jsjy.asia/s/编号 → 官网缓存命中，直接给页面（不碰 CloudBase）
                         └ 缓存作废后第一次打开：官网 GET app.jsjy.asia/share-api/site/shares（x-site-key）一次取回全部有效分享页
```

官网一次取回全部有效分享页、按编号在内存里找：家长打开、有人乱试编号，都不会调到云函数。

## 运维成本

- **资源点**：没有定时器。教务打开后台一次 = 1 次云函数调用 + 2 次数据库读；保存一次 = 1 次调用 + 1 次写 + 通知官网，之后官网取一次全部分享页（1 次调用 + 1 次读）。数据库按「有访问的 5 分钟格」计费（一格约 14 点，那 5 分钟里数据库本来有人用就不另计）：按每天教务用几次、每月建 100 条估，**每月约 50～150 点**。家长打开不计；官网不定时刷新（定时刷新会在夜里多占计费格）。
- **要人做的事**：无。官网没刷新时（官网服务器挂了、密钥不对），后台会黄色提示「官网还没刷新」，要点「再通知一次」或列表上的「通知官网」；官网不会自己定时刷新，之后任何一次保存成功也会把所有分享页一起刷新。
- **出问题怎么查**：
  - 家长看到旧内容 / 新链接显示已失效：后台点「通知官网」；还不行看 `tcb fn log share-api` 里的「通知官网失败」，多半是官网服务器没在跑或 `SITE_KEY` 和官网的 `TEACHER_STATS_KEY` 对不上。
  - 后台「官网老师名单没读到」：官网 `/api/share-teachers` 打不开，先看官网是否正常。
  - 后台「没加载出来」：看 `tcb fn log share-api`。

## 结构

```text
src/domain/share.ts          校验、编号、课程标签筛选（前后端共用）
src/server/handler.ts        分发和权限：教务才能用；官网接口校验 x-site-key（有测试）
functions/share-api/         云函数入口：PostgREST 读写、查 feedback_admins、通知官网
src/web/Shares.tsx           后台：全部链接、新建/编辑（筛老师）、生成好的链接
migrations/                  teacher_shares 建表（可重复执行）
tests/share.test.ts
```

## 第一次部署

后端先上、官网后上（官网会把取到的分享页一直缓存到下次通知，后端没就绪时别让官网先去取）：

1. 建表：`tcb db execute -e jingshi-test-d5gp401i44a0fa7a7 --sql "$(cat apps/teacher-share/migrations/202611270001_teacher_shares.sql)"`
2. `cp server.env.example server.env` 填好（`CLOUDBASE_API_KEY` 和其他模块同一个；`SITE_KEY` = feedback-api 的 `SITE_API_KEY`），`cp .env.example .env`
3. `npm run deploy:functions -w @jingshi/teacher-share`
4. HTTP 访问服务加路由 `app.jsjy.asia/share-api → 云函数 share-api`（`tcb routes add`，和 abroad-api 一样）。验证：`curl https://app.jsjy.asia/share-api/site/shares` 不带密钥回 401，带 `x-site-key` 回 JSON
5. 官网：合并官网仓库的 `feat/teacher-share` 到 main 并推送（服务器每 5 分钟自动部署）。官网不用加新配置：复用已有的 `TEACHER_STATS_KEY`，分享接口地址默认 `https://app.jsjy.asia/share-api/site/shares`（要改就设 `SHARE_LIST_URL`）。验证 `https://jsjy.asia/api/share-teachers` 回 JSON。官网没发上去就停在这一步，别发后台
6. `npm run deploy:web -w @jingshi/teacher-share`
7. 验收（线上，PostgREST 的时间戳比对和编号冲突只有这里能测到）：建一条 → 手机打开 → 编辑后刷新 → 停用（显示已失效）→ 恢复；看 `tcb fn log share-api`。用非管理员的教务账号登录一次，再用老师账号确认被拦下（要本人扫码）。测完删掉测试数据：`delete from public.teacher_shares where code = '<测试编号>';` 再在后台点「通知官网」

## 命令

```bash
npm test -w @jingshi/teacher-share
npm run dev -w @jingshi/teacher-share          # http://localhost:4189/share/（登录见 docs/口径/cloudbase.md「本地联调飞书登录的应用」）
npm run deploy:functions -w @jingshi/teacher-share
npm run deploy:web -w @jingshi/teacher-share   # tcb hosting deploy dist /share
```
