begin;

-- 老师评分的数据源快照。「生成名单」存课程月份的课表，「刷新反馈」存收集月份的答卷，
-- 都是喂给评分脚本的 CSV 原文。评分页只读这里，不用每次等 20–40 秒读整张飞书课表。
create table if not exists public.feedback_source_snapshots (
  kind text not null check (kind in ('schedule', 'feedback')),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  csv text not null,
  row_count integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (kind, month)
);

-- 2026-09 课程月份之前的月度老师分数：从老看板累计结果（monthly_score_contributions.csv）原样导入，
-- 已经对外公布过，作为定稿不再重算。之后的月份由评分脚本按快照实时计算。
create table if not exists public.feedback_score_history (
  course_month text not null check (course_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  teacher text not null,
  hours numeric not null default 0,
  responses integer not null default 0,
  matched_responses integer not null default 0,
  coverage numeric not null default 0,
  learning_effect numeric,
  responsibility numeric,
  charisma numeric,
  source text,
  primary key (course_month, teacher)
);

alter table public.feedback_source_snapshots enable row level security;
alter table public.feedback_score_history enable row level security;
revoke all on public.feedback_source_snapshots from anon;
revoke all on public.feedback_score_history from anon;
grant select, insert, update, delete on public.feedback_source_snapshots to authenticated;
grant select, insert, update, delete on public.feedback_score_history to authenticated;

drop policy if exists feedback_source_snapshots_admin_all on public.feedback_source_snapshots;
create policy feedback_source_snapshots_admin_all
  on public.feedback_source_snapshots for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

drop policy if exists feedback_score_history_admin_all on public.feedback_score_history;
create policy feedback_score_history_admin_all
  on public.feedback_score_history for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

commit;
