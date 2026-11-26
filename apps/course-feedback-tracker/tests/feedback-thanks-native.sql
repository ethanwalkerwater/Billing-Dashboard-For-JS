-- 原生问卷提交后能送感谢礼：和 feedback-thanks.sql 一样，在应用了迁移的本地库上 psql -v ON_ERROR_STOP=1 跑。
-- 提交路径 = feedback-api 写飞书后调 confirm_monthly_feedback；感谢礼后台读的是 feedback_thanks_records。
begin;
insert into public.feedback_tasks (task_id, course_month, collection_month, student_record_id, student_name,
  teacher_source_name, teacher_canonical_name, public_token, status)
values ('native-task', to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM'),
  to_char((now() at time zone 'Asia/Shanghai') + interval '1 month', 'YYYY-MM'),
  'native-student', '原生学生', '原生老师', '原生老师', 'native-token', 'sent');
set local role service_role;
do $$
declare month text := to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM');
begin
  begin
    perform public.submit_feedback_thanks(month, 'native-student', 'native-task', 'coffee', '谢谢老师', 35, '请老师喝一杯');
    raise exception 'thanks accepted before the answer was bound';
  exception when others then
    assert sqlerrm = 'THANKS_NOT_ELIGIBLE', sqlerrm;
  end;
  assert (select student_done and not parent_done from public.confirm_monthly_feedback('native-task', 'recNative', 'student', now()));
  assert (select done from public.submit_feedback_thanks(month, 'native-student', 'native-task', 'coffee', '谢谢老师', 35, '请老师喝一杯'));
  assert (select count(*) = 1 from public.feedback_thanks_records r
    where r.task_id = 'native-task' and r.teacher_name = '原生老师' and r.gift_label = '请老师喝一杯' and r.note = '谢谢老师');
  assert (select sync_status = 'matched' from public.feedback_responses where response_record_id = 'recNative');
end;
$$;
rollback;
