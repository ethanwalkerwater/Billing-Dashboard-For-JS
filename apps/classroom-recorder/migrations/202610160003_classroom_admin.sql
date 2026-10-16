begin;

-- 后台：提示词版本（最新一行 = 线上），管理员登录会话，课程记下生成时用的提示词版本
create table if not exists public.classroom_prompts (
  version integer primary key,
  rules text not null,
  parent text not null,
  report text not null,
  "createdAt" bigint not null,
  "createdBy" text not null
);

create table if not exists public.classroom_admin_sessions (
  "_id" text primary key,              -- sha256(token)
  "openId" text not null,
  name text not null,
  "expiresAt" bigint not null
);

alter table public.classroom_lessons add column if not exists "promptVersion" integer;
-- 登录 state 区分老师 App（null）和后台网页（admin）
alter table public.classroom_auth add column if not exists kind text;

alter table public.classroom_prompts enable row level security;
alter table public.classroom_admin_sessions enable row level security;
revoke all on public.classroom_prompts, public.classroom_admin_sessions from anon, authenticated;

commit;
