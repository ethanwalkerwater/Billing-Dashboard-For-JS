begin;

-- 菁仕课堂：列名与 src/server/logic.ts 的 LessonDoc 字段一一对应（带引号的驼峰），云函数按字段局部 PATCH，不做整行读改写。
create table if not exists public.classroom_auth (
  "_id" text primary key,              -- 登录 state
  status text not null default 'pending' check (status in ('pending', 'done', 'not_teacher')),
  "expiresAt" bigint not null,
  "openId" text,
  name text,
  "scheduleName" text
);

create table if not exists public.classroom_sessions (
  "_id" text primary key,              -- sha256(token)
  "openId" text not null,
  name text not null,
  "scheduleName" text not null,
  "createdAt" bigint not null
);

create table if not exists public.classroom_lessons (
  "_id" text primary key,              -- 飞书课表 record_id
  "teacherOpenId" text not null,
  "teacherName" text not null,
  student text not null default '',
  course text not null default '',
  location text not null default '',
  "startAt" bigint not null,
  "endAt" bigint not null,
  stage text not null check (stage in ('recording', 'queued', 'transcribing', 'summarizing', 'done', 'failed')),
  "failedStage" text,
  attempts integer not null default 0,
  error text,
  "lockedUntil" bigint not null default 0,
  finish jsonb,
  "mergedFileId" text,
  "asrTaskId" bigint,
  transcript text,
  "gapMinutes" integer,
  summary text,
  "editedSummary" text,
  report jsonb,
  "reportToken" text unique,
  copied boolean not null default false,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);
create index if not exists classroom_lessons_stage_idx on public.classroom_lessons (stage) where stage <> 'done';

-- 分段单独成表：上传并发时各写各的行，互不覆盖
create table if not exists public.classroom_segments (
  "lessonId" text not null references public.classroom_lessons("_id") on delete cascade,
  seq integer not null,
  sha256 text not null,
  bytes integer not null,
  "fileId" text not null,
  primary key ("lessonId", seq)
);

-- 只有云函数（service_role）读写
alter table public.classroom_auth enable row level security;
alter table public.classroom_sessions enable row level security;
alter table public.classroom_lessons enable row level security;
alter table public.classroom_segments enable row level security;
revoke all on public.classroom_auth, public.classroom_sessions, public.classroom_lessons, public.classroom_segments from anon, authenticated;

-- 录音分段与合并文件：私有 Storage 桶，只有云函数（API Key）读写，ASR 用签名链接下载
insert into storage.buckets (id, name, public) values ('classroom', 'classroom', false) on conflict (id) do nothing;

commit;
