begin;

create table if not exists public.feedback_admins (
  user_id text primary key,
  email text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.feedback_tasks (
  task_id text primary key,
  course_month text not null check (course_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  collection_month text not null check (collection_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  student_record_id text not null,
  student_name text not null,
  teacher_source_name text not null,
  teacher_canonical_name text not null,
  course_names text[] not null default '{}',
  schedule_record_ids text[] not null default '{}',
  status text not null default 'unsent' check (status in ('unsent', 'sent', 'completed', 'declined')),
  public_token text not null unique,
  sent_at timestamptz,
  submitted_at timestamptz,
  response_record_ids text[] not null default '{}',
  validation_issues jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_month, student_record_id, teacher_canonical_name)
);

create index if not exists feedback_tasks_collection_status_idx
  on public.feedback_tasks (collection_month, status);
create index if not exists feedback_tasks_teacher_idx
  on public.feedback_tasks (collection_month, teacher_canonical_name);
create index if not exists feedback_tasks_student_idx
  on public.feedback_tasks (collection_month, student_name);

create table if not exists public.feedback_responses (
  response_record_id text primary key,
  task_id text references public.feedback_tasks(task_id) on delete set null,
  submitted_at timestamptz not null,
  sync_status text not null check (sync_status in ('matched', 'duplicate', 'exception')),
  exception_code text,
  received_payload_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedback_responses_task_idx
  on public.feedback_responses (task_id, submitted_at desc);

create table if not exists public.feedback_sync_runs (
  run_id text primary key,
  sync_type text not null check (sync_type in ('tasks', 'responses', 'form-options', 'task-mirror')),
  course_month text,
  collection_month text,
  trigger_source text not null,
  status text not null check (status in ('running', 'completed', 'partial', 'failed')),
  cursor_value text,
  success_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  error_summary jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists feedback_sync_runs_recent_idx
  on public.feedback_sync_runs (started_at desc);

create table if not exists public.feedback_qr_batches (
  batch_id text primary key,
  collection_month text not null,
  status text not null check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'expired')),
  task_ids text[] not null default '{}',
  filter_snapshot jsonb not null default '{}'::jsonb,
  total_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  zip_file_id text,
  error_summary jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.feedback_audit_logs (
  audit_id text primary key,
  actor_id text,
  action text not null,
  task_id text references public.feedback_tasks(task_id) on delete set null,
  request_id text,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

create index if not exists feedback_audit_logs_task_idx
  on public.feedback_audit_logs (task_id, created_at desc);

create or replace function public.is_feedback_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.feedback_admins
    where user_id = (select auth.uid())::text
      and active = true
  );
$$;

revoke all on function public.is_feedback_admin() from public;
grant execute on function public.is_feedback_admin() to authenticated, service_role;

alter table public.feedback_admins enable row level security;
alter table public.feedback_tasks enable row level security;
alter table public.feedback_responses enable row level security;
alter table public.feedback_sync_runs enable row level security;
alter table public.feedback_qr_batches enable row level security;
alter table public.feedback_audit_logs enable row level security;

revoke all on public.feedback_admins from anon;
revoke all on public.feedback_tasks from anon;
revoke all on public.feedback_responses from anon;
revoke all on public.feedback_sync_runs from anon;
revoke all on public.feedback_qr_batches from anon;
revoke all on public.feedback_audit_logs from anon;

grant select on public.feedback_admins to authenticated;
grant select, insert, update, delete on public.feedback_tasks to authenticated;
grant select, insert, update, delete on public.feedback_responses to authenticated;
grant select, insert, update, delete on public.feedback_sync_runs to authenticated;
grant select, insert, update, delete on public.feedback_qr_batches to authenticated;
grant select, insert on public.feedback_audit_logs to authenticated;

create policy feedback_admins_admin_select
  on public.feedback_admins for select to authenticated
  using ((select public.is_feedback_admin()));

create policy feedback_tasks_admin_all
  on public.feedback_tasks for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

create policy feedback_responses_admin_all
  on public.feedback_responses for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

create policy feedback_sync_runs_admin_all
  on public.feedback_sync_runs for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

create policy feedback_qr_batches_admin_all
  on public.feedback_qr_batches for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

create policy feedback_audit_logs_admin_select
  on public.feedback_audit_logs for select to authenticated
  using ((select public.is_feedback_admin()));

create policy feedback_audit_logs_admin_insert
  on public.feedback_audit_logs for insert to authenticated
  with check ((select public.is_feedback_admin()));

commit;
