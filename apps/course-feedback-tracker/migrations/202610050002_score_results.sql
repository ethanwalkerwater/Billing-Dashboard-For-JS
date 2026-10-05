begin;

-- 每个课程月份算好的老师评分（含学生/家长分项）和逐条明细。评分页、切月份、切标签都直接读这张表，
-- 不再每次调云函数现算。只有答卷或课表快照真的变了（inputs_hash 不同）才重算一次。
--   draft：收集月份还没结束，刷新反馈时会更新
--   final：收集月份已结束，定稿，不再自动重算
create table if not exists public.feedback_score_results (
  course_month text primary key check (course_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status text not null check (status in ('draft', 'final')),
  -- live：按快照实时计算；history：老看板已公布的分数（分项为按原始反馈补算）
  source text not null check (source in ('live', 'history')),
  teachers jsonb not null default '[]'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  detail jsonb not null default '[]'::jsonb,
  -- 算不出来时的原因（例如这个月还没有反馈）
  error text,
  inputs_hash text,
  computed_at timestamptz not null default now()
);

alter table public.feedback_score_results enable row level security;
revoke all on public.feedback_score_results from anon;
grant select, insert, update, delete on public.feedback_score_results to authenticated;
drop policy if exists feedback_score_results_admin_all on public.feedback_score_results;
create policy feedback_score_results_admin_all
  on public.feedback_score_results for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

commit;
