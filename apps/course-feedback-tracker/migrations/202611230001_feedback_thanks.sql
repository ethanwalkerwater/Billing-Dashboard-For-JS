begin;

create table if not exists public.feedback_thanks_gifts (
  id text primary key,
  label text not null check (label ~ '[^[:space:]]' and length(label) <= 20),
  description text not null default '' check (length(description) <= 30),
  value numeric not null check (value between 0 and 9999 and value = round(value, 2)),
  photo text check (case
    when photo is null then true
    when length(photo) <= 160000 and photo ~ '^data:image/webp;base64,[A-Za-z0-9+/]+={0,2}$'
      and length(substr(photo, 24)) % 4 = 0 and length(photo) >= 47
    then substr(decode(substr(photo, 24, 16), 'base64'), 1, 4) = 'RIFF'::bytea
      and substr(decode(substr(photo, 24, 16), 'base64'), 9, 4) = 'WEBP'::bytea
    else false end),
  enabled boolean not null default true,
  sort_order integer not null
);

insert into public.feedback_thanks_gifts (id, label, description, value, sort_order) values
  ('coffee', '请老师喝一杯', '辛苦了，放松一下', 35, 1),
  ('flowers', '送老师一束花', '感谢您的用心', 45, 2),
  ('cake', '给老师一点甜', '谢谢您的耐心陪伴', 40, 3),
  ('pennant', '为老师送上荣誉', '感谢您的专业指导', 50, 4)
on conflict (id) do nothing;

-- Keep historical gifts even if feedback is unlinked and its task is later removed.
create table if not exists public.feedback_thanks_records (
  task_id text primary key,
  course_month text not null,
  student_name text not null,
  teacher_name text not null,
  gift_label text not null,
  gift_value numeric not null,
  note text not null check (note ~ '[^[:space:]]' and length(note) <= 200),
  status text not null default 'pending' check (status in ('pending', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists feedback_thanks_records_month_created_idx
  on public.feedback_thanks_records (course_month, created_at desc);

alter table public.feedback_thanks_gifts enable row level security;
alter table public.feedback_thanks_records enable row level security;
revoke all on public.feedback_thanks_gifts, public.feedback_thanks_records from public, anon, authenticated, service_role;
grant select on public.feedback_thanks_gifts, public.feedback_thanks_records to authenticated, service_role;
grant update (label, description, value, photo, enabled) on public.feedback_thanks_gifts to authenticated;
grant update (status) on public.feedback_thanks_records to authenticated;

drop policy if exists feedback_thanks_gifts_detail on public.feedback_thanks_gifts;
create policy feedback_thanks_gifts_detail on public.feedback_thanks_gifts for all to authenticated
  using ((select public.is_feedback_detail())) with check ((select public.is_feedback_detail()));
drop policy if exists feedback_thanks_records_detail on public.feedback_thanks_records;
create policy feedback_thanks_records_detail on public.feedback_thanks_records for all to authenticated
  using ((select public.is_feedback_detail())) with check ((select public.is_feedback_detail()));

create or replace function public.feedback_thanks_options(p_task_id text)
returns setof public.feedback_thanks_gifts
language sql stable security invoker set search_path = '' as $$
  select g.* from public.feedback_thanks_gifts g
  where g.enabled and not exists (select 1 from public.feedback_thanks_records r where r.task_id = p_task_id)
  order by g.sort_order, g.id;
$$;
revoke all on function public.feedback_thanks_options(text) from public, anon, authenticated;
grant execute on function public.feedback_thanks_options(text) to service_role;

create or replace function public.submit_feedback_thanks(
  p_month text, p_student_id text, p_task_id text, p_gift_id text, p_note text,
  p_expected_value numeric, p_expected_label text
) returns table (done boolean)
language plpgsql security definer set search_path = '' as $$
declare
  task public.feedback_monthly_link_tasks%rowtype;
  gift public.feedback_thanks_gifts%rowtype;
begin
  if p_note is null or p_note !~ '[^[:space:]]' or length(p_note) > 200
    or nullif(p_gift_id, '') is null or nullif(p_expected_label, '') is null
    or p_expected_value is null or p_expected_value not between 0 and 9999
    or p_expected_value <> round(p_expected_value, 2) then
    raise exception 'THANKS_INVALID';
  end if;

  -- Serialize retries against the same task, including a simultaneous feedback reconciliation.
  perform 1 from public.feedback_tasks t where t.task_id = p_task_id
    and t.course_month = p_month and t.student_record_id = p_student_id for update;
  if not found then raise exception 'THANKS_NOT_ELIGIBLE'; end if;

  select m.* into task from public.feedback_monthly_link_tasks m
  where m.task_id = p_task_id and m.course_month = p_month and m.student_record_id = p_student_id
    and not m.closed and (m.student_response_id is not null or m.parent_response_id is not null)
    and m.course_month >= to_char((now() at time zone 'Asia/Shanghai') - interval '1 month', 'YYYY-MM');
  if not found then raise exception 'THANKS_NOT_ELIGIBLE'; end if;

  if not exists (select 1 from public.feedback_thanks_records r where r.task_id = p_task_id) then
    select g.* into gift from public.feedback_thanks_gifts g where g.id = p_gift_id
      and g.enabled and g.label = p_expected_label and g.value = p_expected_value for share;
    if not found then raise exception 'THANKS_GIFT_CHANGED'; end if;

    insert into public.feedback_thanks_records
      (task_id, course_month, student_name, teacher_name, gift_label, gift_value, note)
    values (task.task_id, task.course_month, task.student_name, task.teacher_canonical_name,
      gift.label, gift.value, btrim(p_note));
  end if;
  return query select true;
end;
$$;
revoke all on function public.submit_feedback_thanks(text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.submit_feedback_thanks(text,text,text,text,text,numeric,text) to service_role;

commit;
