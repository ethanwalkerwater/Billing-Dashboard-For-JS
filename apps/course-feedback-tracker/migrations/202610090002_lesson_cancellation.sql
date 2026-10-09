begin;

-- 学生自助取消课程：每个学生一个专属链接（随机 token，可停用重发）。
create table if not exists public.cancel_links (
  token text primary key,
  student_key text not null,
  student_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists cancel_links_student_idx on public.cancel_links (student_key) where active;

-- 一次性取消编号：选课页确认时生成，30 分钟内随飞书问卷提交才有效，只能用一次。
create table if not exists public.cancel_intents (
  intent_id text primary key,
  token text not null references public.cancel_links(token),
  student_key text not null,
  student_name text not null,
  schedule_record_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  request_record_id text,
  tier text,
  reason text,
  message text,
  processed_at timestamptz
);

create index if not exists cancel_intents_lesson_idx on public.cancel_intents (schedule_record_id);

-- 只有云函数（service_role）读写；教务管理员可在工作台只读查看。
alter table public.cancel_links enable row level security;
alter table public.cancel_intents enable row level security;
revoke all on public.cancel_links from anon, authenticated;
revoke all on public.cancel_intents from anon, authenticated;
grant select on public.cancel_links to authenticated;
grant select on public.cancel_intents to authenticated;
drop policy if exists cancel_links_admin_read on public.cancel_links;
create policy cancel_links_admin_read on public.cancel_links for select to authenticated
  using ((select public.is_feedback_admin()));
drop policy if exists cancel_intents_admin_read on public.cancel_intents;
create policy cancel_intents_admin_read on public.cancel_intents for select to authenticated
  using ((select public.is_feedback_admin()));

commit;
