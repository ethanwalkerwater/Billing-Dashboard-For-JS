begin;

-- 合并反馈：老师选同一个学生的几节课，另外合并一份家长总结和学情报告（kind = merged，没有录音和转写，单节课的行不动）
alter table public.classroom_lessons drop constraint if exists classroom_lessons_kind_check;
alter table public.classroom_lessons add constraint classroom_lessons_kind_check check (kind in ('lesson', 'adhoc', 'meeting', 'merged'));
-- 由哪几节课合并（课程编号，按上课时间）
alter table public.classroom_lessons add column if not exists sources jsonb;

commit;
