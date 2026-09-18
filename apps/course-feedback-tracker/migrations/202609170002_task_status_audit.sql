begin;

-- 状态变更审计写在数据库触发器里，前端（PostgREST + RLS）和云函数（服务端身份）
-- 都改同一张表，谁也绕不过去；应用代码不需要各自记一遍。
create or replace function public.log_feedback_task_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  insert into public.feedback_audit_logs (audit_id, actor_id, action, task_id, old_value, new_value)
  values (
    gen_random_uuid()::text,
    coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), 'service'),
    case when tg_op = 'INSERT' then 'task-created' else 'status-change' end,
    new.task_id,
    case when tg_op = 'INSERT' then null else jsonb_build_object('status', old.status, 'submittedAt', old.submitted_at) end,
    jsonb_build_object('status', new.status, 'submittedAt', new.submitted_at)
  );
  return new;
end;
$$;

drop trigger if exists feedback_tasks_status_audit on public.feedback_tasks;
create trigger feedback_tasks_status_audit
  after insert or update on public.feedback_tasks
  for each row execute function public.log_feedback_task_status_change();

-- updated_at 由触发器兜底，避免客户端漏传。
create or replace function public.touch_feedback_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists feedback_tasks_touch on public.feedback_tasks;
create trigger feedback_tasks_touch
  before update on public.feedback_tasks
  for each row execute function public.touch_feedback_updated_at();

commit;
