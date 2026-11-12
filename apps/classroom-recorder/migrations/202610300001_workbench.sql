begin;

-- 菁仕工作台（/classroom/workbench/）：和菁仕课堂同库同函数，表名前缀 wb_。设计见 docs/学生档案.html「需求分析」。

-- 飞书数据的快照：m:YYYY-MM = 当月课表（紧凑数组），roster = 学员信息表。打开页面时按过期时间同步，不加定时器
create table if not exists public.wb_cache (
  key text primary key,
  data jsonb not null,
  "syncedAt" bigint not null default 0
);

-- 教务名单（超级管理员在「录课管理」里增删）；管理员沿用 classroom_admins + ADMIN_OPEN_IDS
create table if not exists public.wb_roles (
  "openId" text primary key,
  name text not null,
  role text not null default 'staff' check (role in ('staff')),
  "addedBy" text not null,
  "addedAt" bigint not null
);

-- 学生在工作台里补的东西：阶段、画像、目标。_id = 飞书学员信息 record_id
create table if not exists public.wb_students (
  "_id" text primary key,
  stage text,
  persona jsonb not null default '{}',
  goals jsonb not null default '{"aim":"","rows":[]}',
  "suggestBasis" text,
  "updatedAt" bigint not null,
  "updatedBy" text not null
);

-- 学员列表的列由教务定义；每门课每个月每列一个值
create table if not exists public.wb_config (
  key text primary key,
  value jsonb not null,
  "updatedAt" bigint not null,
  "updatedBy" text not null
);
create table if not exists public.wb_marks (
  month text not null,
  student text not null,
  course text not null,
  field text not null,
  value text not null,
  "updatedAt" bigint not null,
  "updatedBy" text not null,
  primary key (month, student, course, field)
);

-- AI 月报：一个学生一门课一个月一份；basis = 生成时用到的课程编号，edited = 老师或教务改过
create table if not exists public.wb_monthly (
  student text not null,
  course text not null,
  month text not null,
  rep jsonb not null,
  basis text not null,
  "editedBy" text,
  "updatedAt" bigint not null,
  primary key (student, course, month)
);

create table if not exists public.wb_milestones (
  "_id" text primary key,
  student text not null,
  date text not null,
  course text not null default '',
  title text not null,
  text text not null default '',
  files jsonb not null default '[]',
  "by" text not null,
  "createdAt" bigint not null
);
create index if not exists wb_milestones_student_idx on public.wb_milestones (student);

create table if not exists public.wb_grades (
  "_id" text primary key,
  student text not null,
  date text not null,
  exam text not null,
  subject text not null,
  score text not null,
  file jsonb,
  "by" text not null,
  "createdAt" bigint not null
);

create table if not exists public.wb_todos (
  "_id" text primary key,
  student text not null,
  text text not null,
  owner text not null,
  due text not null,
  done boolean not null default false,
  result text,
  "by" text not null,
  "createdAt" bigint not null,
  "doneAt" bigint
);

-- AI 画像建议：open 待处理，accepted 已采纳，ignored 忽略（30 天内不再提）
create table if not exists public.wb_suggestions (
  "_id" text primary key,
  student text not null,
  key text not null,
  tag text not null,
  why text not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'ignored')),
  "createdAt" bigint not null,
  "decidedBy" text,
  "decidedAt" bigint
);
create index if not exists wb_suggestions_student_idx on public.wb_suggestions (student);

-- 登录时按老师档案对上的课表名；工作台按它筛课表
alter table public.classroom_admin_sessions add column if not exists "scheduleName" text;

alter table public.wb_cache enable row level security;
alter table public.wb_roles enable row level security;
alter table public.wb_students enable row level security;
alter table public.wb_config enable row level security;
alter table public.wb_marks enable row level security;
alter table public.wb_monthly enable row level security;
alter table public.wb_milestones enable row level security;
alter table public.wb_grades enable row level security;
alter table public.wb_todos enable row level security;
alter table public.wb_suggestions enable row level security;
revoke all on public.wb_cache, public.wb_roles, public.wb_students, public.wb_config, public.wb_marks, public.wb_monthly,
  public.wb_milestones, public.wb_grades, public.wb_todos, public.wb_suggestions from anon, authenticated;

commit;
