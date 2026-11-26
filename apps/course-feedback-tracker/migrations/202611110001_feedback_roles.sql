-- 月度课程反馈分权限（2026-11-11 用户要求，只管反馈工作台这一个产品）：
-- 飞书全员仍可登录，新账号 role=teacher：问卷跟踪、老师评分（分数、排名）、课程类型都能看，
-- 但看不到「谁给了几分」——每份反馈明细、文字评价、答卷原文只给 admin / super。
-- super 在「管理员设置」里改别人的 role。前端口径见 src/shared/roles.ts。
--
-- is_feedback_admin() 不改（仍是「已开通的账号」），取消课程、雅思、薪资预警等其他产品照旧。
-- 本迁移可重复执行。
begin;

alter table public.feedback_admins
  add column if not exists role text not null default 'teacher'
  check (role in ('teacher', 'admin', 'super'));

update public.feedback_admins set role = 'admin' where display_name in ('黄钢', '罗健文', '包天翊') and role = 'teacher';
update public.feedback_admins set role = 'super' where display_name = '徐翰超';

-- 能看评分明细（谁给了几分）
create or replace function public.is_feedback_detail()
returns boolean language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1 from public.feedback_admins
    where user_id = (select auth.uid())::text and active = true and role in ('admin', 'super')
  );
$$;

create or replace function public.is_feedback_super()
returns boolean language sql stable security definer set search_path = public, auth
as $$
  select exists (select 1 from public.feedback_admins where user_id = (select auth.uid())::text and active = true and role = 'super');
$$;

revoke all on function public.is_feedback_detail() from public;
revoke all on function public.is_feedback_super() from public;
grant execute on function public.is_feedback_detail() to authenticated, service_role;
grant execute on function public.is_feedback_super() to authenticated, service_role;

-- 只有 super 能改 role 这一列（读仍按原来的 feedback_admins_admin_select）
grant update (role) on public.feedback_admins to authenticated;
drop policy if exists feedback_admins_super_update on public.feedback_admins;
create policy feedback_admins_super_update on public.feedback_admins for update to authenticated
  using ((select public.is_feedback_super())) with check ((select public.is_feedback_super()));

-- 答卷快照（kind=feedback）是每份答卷原文：只给能看明细的；课表快照（课程类型页要读）所有人可读
drop policy if exists feedback_source_snapshots_admin_all on public.feedback_source_snapshots;
drop policy if exists feedback_source_snapshots_detail_all on public.feedback_source_snapshots;
create policy feedback_source_snapshots_detail_all on public.feedback_source_snapshots for all to authenticated
  using ((select public.is_feedback_detail())) with check ((select public.is_feedback_detail()));
drop policy if exists feedback_source_snapshots_schedule_select on public.feedback_source_snapshots;
create policy feedback_source_snapshots_schedule_select on public.feedback_source_snapshots for select to authenticated
  using (kind <> 'feedback' and (select public.is_feedback_admin()));

-- 评分结果的 detail 列是逐份明细：表本身只给能看明细的，其余列走下面的视图
drop policy if exists feedback_score_results_admin_all on public.feedback_score_results;
drop policy if exists feedback_score_results_detail_all on public.feedback_score_results;
create policy feedback_score_results_detail_all on public.feedback_score_results for all to authenticated
  using ((select public.is_feedback_detail())) with check ((select public.is_feedback_detail()));

-- 两个视图按建表人的权限读、不受上面 RLS 限制，所以自己判断 is_feedback_admin()；都不带明细和原文。
create or replace view public.feedback_score_summaries as
  select course_month, status, source, teachers, stats, error, inputs_hash, computed_at, preferences, published_at, published_by
  from public.feedback_score_results
  where (select public.is_feedback_admin());
revoke all on public.feedback_score_summaries from anon;
grant select on public.feedback_score_summaries to authenticated;

create or replace view public.feedback_sync_times as
  select kind, month, row_count, synced_at
  from public.feedback_source_snapshots
  where (select public.is_feedback_admin());
revoke all on public.feedback_sync_times from anon;
grant select on public.feedback_sync_times to authenticated;

commit;
