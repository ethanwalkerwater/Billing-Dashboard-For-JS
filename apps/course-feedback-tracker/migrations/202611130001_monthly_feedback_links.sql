begin;

-- The task key already indexes course month and student ID.
create or replace view public.feedback_monthly_link_tasks
with (security_invoker = true) as
select t.task_id, t.course_month, t.collection_month, t.student_record_id,
       t.student_name, t.teacher_canonical_name, t.course_names,
       t.student_response_id, t.parent_response_id,
       coalesce(s.status = 'final', false) as closed
from public.feedback_tasks t
left join public.feedback_score_results s on s.course_month = t.course_month
where t.status <> 'declined'
  and not exists (
    select 1 from public.feedback_excluded_teachers e
    where lower(regexp_replace(normalize(e.teacher_name, NFKC), '[[:space:]]', '', 'g')) =
          lower(regexp_replace(normalize(t.teacher_canonical_name, NFKC), '[[:space:]]', '', 'g'))
  )
  and not exists (
    select 1 from public.feedback_excluded_students e
    where lower(regexp_replace(normalize(e.student_name, NFKC), '[[:space:]]', '', 'g')) =
          lower(regexp_replace(normalize(t.student_name, NFKC), '[[:space:]]', '', 'g'))
  );

revoke all on public.feedback_monthly_link_tasks from public, anon, authenticated;
grant select on public.feedback_monthly_link_tasks to service_role;

create or replace function public.confirm_monthly_feedback(
  p_task_id text, p_record_id text, p_identity text, p_submitted_at timestamptz
) returns table (student_done boolean, parent_done boolean)
language plpgsql set search_path = '' as $$
declare
  task public.feedback_tasks%rowtype;
  occupied text;
begin
  if p_identity is null or p_identity not in ('student', 'parent') then
    raise exception 'invalid response identity';
  end if;
  select * into strict task from public.feedback_tasks where task_id = p_task_id for update;
  occupied := case when p_identity = 'student' then task.student_response_id else task.parent_response_id end;
  if occupied = p_record_id then
    return query select task.student_response_id is not null, task.parent_response_id is not null;
    return;
  end if;

  insert into public.feedback_responses (
    response_record_id, task_id, submitted_at, collection_month, student_name, teacher_name,
    identity, bound_by, sync_status
  ) values (
    p_record_id, task.task_id, p_submitted_at, task.collection_month, task.student_name,
    task.teacher_canonical_name, p_identity, 'name', case when occupied is null then 'matched' else 'duplicate' end
  ) on conflict (response_record_id) do nothing;

  if not exists (select 1 from public.feedback_responses r where r.response_record_id = p_record_id
    and r.task_id = task.task_id and r.identity = p_identity) then
    raise exception 'response already belongs to another task';
  end if;

  if occupied is null then
    update public.feedback_tasks as t set
      student_response_id = case when p_identity = 'student' then p_record_id else t.student_response_id end,
      parent_response_id = case when p_identity = 'parent' then p_record_id else t.parent_response_id end,
      status = 'completed', submitted_at = least(t.submitted_at, p_submitted_at),
      bound_by = coalesce(t.bound_by, 'name'), updated_at = now()
    where t.task_id = p_task_id returning t.* into task;
  end if;
  return query select task.student_response_id is not null, task.parent_response_id is not null;
end;
$$;

revoke all on function public.confirm_monthly_feedback(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.confirm_monthly_feedback(text, text, text, timestamptz) to service_role;

create or replace function public.apply_feedback_task_sync(p_remove text[], p_create jsonb, p_update jsonb)
returns void language sql set search_path = '' as $$
  delete from public.feedback_tasks
  where task_id = any(p_remove) and student_response_id is null and parent_response_id is null;

  insert into public.feedback_tasks (
    task_id, course_month, collection_month, student_record_id, student_name, teacher_source_name,
    teacher_canonical_name, course_names, schedule_record_ids, lessons, status, public_token,
    response_record_ids, validation_issues, created_at, updated_at
  ) select task_id, course_month, collection_month, student_record_id, student_name, teacher_source_name,
    teacher_canonical_name, course_names, schedule_record_ids, lessons, status, public_token,
    response_record_ids, validation_issues, created_at, updated_at
  from jsonb_populate_recordset(null::public.feedback_tasks, p_create)
  on conflict (task_id) do nothing;

  update public.feedback_tasks t set
    student_name = v.student_name, teacher_source_name = v.teacher_source_name,
    teacher_canonical_name = v.teacher_canonical_name, course_names = v.course_names,
    schedule_record_ids = v.schedule_record_ids, lessons = v.lessons, updated_at = v.updated_at
  from jsonb_populate_recordset(null::public.feedback_tasks, p_update) v
  where t.task_id = v.task_id and t.student_response_id is null and t.parent_response_id is null;
$$;

revoke all on function public.apply_feedback_task_sync(text[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_feedback_task_sync(text[], jsonb, jsonb) to service_role;

commit;
