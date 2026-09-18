-- 教师薪资预警。复用反馈追踪系统的 feedback_admins 白名单 + is_feedback_admin()，同一个 jsjy 账号登录。
begin;

create table if not exists public.income_teacher_months (
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  teacher text not null,
  lesson_fee numeric(12,2) not null default 0,
  lessons integer not null default 0,
  hours numeric(8,2) not null default 0,
  students text[] not null default '{}',
  unit_price_auto numeric(10,2),
  synced_at timestamptz not null default now(),
  primary key (month, teacher)
);

create table if not exists public.income_teachers (
  teacher text primary key,
  base_salary numeric(12,2),
  unit_price numeric(10,2),
  note text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.income_settings (
  id integer primary key check (id = 1),
  min_rate numeric(5,4) not null default 0.47,
  max_rate numeric(5,4) not null default 0.62,
  updated_at timestamptz not null default now()
);
insert into public.income_settings (id) values (1) on conflict do nothing;

alter table public.income_teacher_months enable row level security;
alter table public.income_teachers enable row level security;
alter table public.income_settings enable row level security;

grant select, insert, update, delete on public.income_teacher_months to authenticated;
grant select, insert, update, delete on public.income_teachers to authenticated;
grant select, insert, update on public.income_settings to authenticated;

drop policy if exists income_teacher_months_admin_all on public.income_teacher_months;
create policy income_teacher_months_admin_all on public.income_teacher_months
  for all to authenticated using ((select public.is_feedback_admin())) with check ((select public.is_feedback_admin()));
drop policy if exists income_teachers_admin_all on public.income_teachers;
create policy income_teachers_admin_all on public.income_teachers
  for all to authenticated using ((select public.is_feedback_admin())) with check ((select public.is_feedback_admin()));
drop policy if exists income_settings_admin_all on public.income_settings;
create policy income_settings_admin_all on public.income_settings
  for all to authenticated using ((select public.is_feedback_admin())) with check ((select public.is_feedback_admin()));

commit;
