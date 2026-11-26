-- Run with psql -v ON_ERROR_STOP=1 against a local database with the module migrations applied.
begin;

create function pg_temp.expect_error(command text, message text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if sqlerrm = message or sqlstate = message then return; end if;
    raise;
  end;
  raise exception 'Expected error % for %', message, command;
end;
$$;

create function pg_temp.month(offset_months integer default 0) returns text language sql stable as $$
  select to_char((now() at time zone 'Asia/Shanghai') + make_interval(months => offset_months), 'YYYY-MM');
$$;
create function pg_temp.send(task text default 'thanks-eligible', student text default 'thanks-student',
  month text default pg_temp.month(), label text default '请老师喝一杯', value numeric default 35,
  note text default '谢谢老师') returns boolean language sql as $$
  select done from public.submit_feedback_thanks(month, student, task, 'coffee', note, value, label);
$$;

insert into public.feedback_admins (user_id, role, feishu_open_id, active) values
  ('thanks-test-admin', 'admin', 'ou_thanks_admin', true),
  ('thanks-test-super', 'super', 'ou_thanks_super', true),
  ('thanks-test-teacher', 'teacher', 'ou_thanks_teacher', true),
  ('thanks-test-unbound', 'teacher', null, true),
  ('thanks-test-inactive', 'teacher', 'ou_thanks_inactive', false);
insert into public.feedback_tasks (task_id, course_month, collection_month, student_record_id, student_name,
  teacher_source_name, teacher_canonical_name, public_token, status, student_response_id, parent_response_id)
select 'thanks-' || name, pg_temp.month(offset_months), pg_temp.month(offset_months + 1), 'thanks-student',
  'thanks-test-student', name, name, 'thanks-token-' || name, status, student_response, parent_response
from (values
  ('eligible', 0, 'completed', 'answer', null), ('parent', -1, 'completed', null, 'answer2'),
  ('unanswered', 0, 'sent', null, null), ('excluded', 0, 'completed', 'answer3', null),
  ('declined', 0, 'declined', 'answer4', null), ('old', -2, 'completed', 'answer5', null)
) v(name, offset_months, status, student_response, parent_response);
insert into public.feedback_excluded_teachers (teacher_name) values ('EXCL UDED');

set local role anon;
select pg_temp.expect_error('select * from public.feedback_thanks_records', '42501');
select pg_temp.expect_error('select * from public.feedback_thanks_gifts', '42501');
select pg_temp.expect_error('select pg_temp.send()', '42501');
select pg_temp.expect_error($q$select * from public.feedback_thanks_options('thanks-eligible')$q$, '42501');
reset role;

set local role service_role;
do $$
begin
  assert (select array_agg(id) from public.feedback_thanks_options('thanks-eligible')) =
    array['coffee','flowers','cake','pennant'];
  assert pg_temp.send();
  assert not exists (select from public.feedback_thanks_options('thanks-eligible'));
end;
$$;
select pg_temp.expect_error($q$select pg_temp.send(student => 'someone-else')$q$, 'THANKS_NOT_ELIGIBLE');
select pg_temp.expect_error($q$select pg_temp.send(month => pg_temp.month(-1))$q$, 'THANKS_NOT_ELIGIBLE');
select pg_temp.expect_error($q$select pg_temp.send('thanks-excluded')$q$, 'THANKS_NOT_ELIGIBLE');
select pg_temp.expect_error($q$select pg_temp.send('thanks-declined')$q$, 'THANKS_NOT_ELIGIBLE');
select pg_temp.expect_error($q$select pg_temp.send('thanks-unanswered')$q$, 'THANKS_NOT_ELIGIBLE');
select pg_temp.expect_error($q$select pg_temp.send('thanks-old', month => pg_temp.month(-2))$q$, 'THANKS_NOT_ELIGIBLE');
select pg_temp.expect_error($q$select pg_temp.send('thanks-parent', month => pg_temp.month(-1), value => 34)$q$, 'THANKS_GIFT_CHANGED');
select pg_temp.expect_error($q$select pg_temp.send('thanks-parent', month => pg_temp.month(-1), label => '改名')$q$, 'THANKS_GIFT_CHANGED');
select pg_temp.expect_error($q$select pg_temp.send(note => E' \n\t')$q$, 'THANKS_INVALID');
select pg_temp.expect_error($q$select pg_temp.send(note => repeat('字', 201))$q$, 'THANKS_INVALID');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'thanks-test-unbound';
do $$
declare changed integer;
begin
  assert not exists (select from public.feedback_thanks_gifts);
  assert not exists (select from public.feedback_thanks_records);
  update public.feedback_thanks_gifts set enabled = false;
  get diagnostics changed = row_count;
  assert changed = 0;
  update public.feedback_thanks_records set status = 'done';
  get diagnostics changed = row_count;
  assert changed = 0;
end;
$$;
set local request.jwt.claim.sub = 'thanks-test-inactive';
do $$ begin
  assert not exists (select from public.feedback_thanks_records);
  assert not exists (select from public.feedback_thanks_gifts);
end; $$;
set local request.jwt.claim.sub = 'thanks-test-admin';
do $$ begin
  assert exists (select from public.feedback_thanks_gifts);
end; $$;
set local request.jwt.claim.sub = 'thanks-test-teacher';
select pg_temp.expect_error('select pg_temp.send()', '42501');
select pg_temp.expect_error($q$select * from public.feedback_thanks_options('thanks-eligible')$q$, '42501');
select pg_temp.expect_error($q$update public.feedback_thanks_records set gift_value = 0$q$, '42501');
select pg_temp.expect_error($q$update public.feedback_thanks_gifts set id = 'different'$q$, '42501');
select pg_temp.expect_error($q$insert into public.feedback_thanks_records default values$q$, '42501');
select pg_temp.expect_error($q$delete from public.feedback_thanks_records$q$, '42501');
select pg_temp.expect_error($q$insert into public.feedback_thanks_gifts default values$q$, '42501');
select pg_temp.expect_error($q$delete from public.feedback_thanks_gifts$q$, '42501');
select pg_temp.expect_error($q$update public.feedback_thanks_gifts set photo = 'data:image/webp;base64,' || repeat('A', 160000)$q$, '23514');
select pg_temp.expect_error($q$update public.feedback_thanks_gifts set photo = 'data:image/webp;base64,' || repeat('A', 40)$q$, '23514');
update public.feedback_thanks_gifts set enabled = false, value = 36, label = '新名称',
  photo = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA=='
  where id = 'coffee';
update public.feedback_thanks_records set status = 'done' where task_id = 'thanks-eligible';
set local request.jwt.claim.sub = 'thanks-test-super';
do $$
begin
  assert (select count(*) from public.feedback_thanks_gifts) = 4;
  assert (select status = 'done' and gift_label = '请老师喝一杯' and gift_value = 35
    from public.feedback_thanks_records where task_id = 'thanks-eligible');
end;
$$;
reset role;

set local role service_role;
do $$
begin
  assert pg_temp.send(note => '重复提交保留原文');
  assert (select note = '谢谢老师' from public.feedback_thanks_records where task_id = 'thanks-eligible');
  assert (select count(*) from public.feedback_thanks_options('thanks-parent')) = 3;
end;
$$;
select pg_temp.expect_error($q$select pg_temp.send('thanks-parent', month => pg_temp.month(-1), label => '新名称', value => 36)$q$, 'THANKS_GIFT_CHANGED');
reset role;

update public.feedback_thanks_gifts set enabled = true where id = 'coffee';
insert into public.feedback_score_results (course_month, status, source) values (pg_temp.month(-1), 'final', 'live');
set local role service_role;
select pg_temp.expect_error($q$select pg_temp.send('thanks-parent', month => pg_temp.month(-1), label => '新名称', value => 36)$q$, 'THANKS_NOT_ELIGIBLE');
reset role;
update public.feedback_score_results set status = 'draft' where course_month = pg_temp.month(-1);
set local role service_role;
do $$
begin
  assert pg_temp.send('thanks-parent', month => pg_temp.month(-1), label => '新名称', value => 36);
  assert (select count(*) from public.feedback_thanks_records) = 2;
end;
$$;
rollback;
