begin;

-- 随时录制：lesson = 课表里的课；adhoc = 随时录制选「课程」；meeting = 随时录制选「会议」（出会议纪要，不出学情报告）
alter table public.classroom_lessons add column if not exists kind text not null default 'lesson'
  check (kind in ('lesson', 'adhoc', 'meeting'));
-- 录音保留 30 天，过期删掉分段和 merged.mp3 后记下时间；转写和总结保留
alter table public.classroom_lessons add column if not exists "audioDeletedAt" bigint;
create index if not exists classroom_lessons_teacher_kind_idx on public.classroom_lessons ("teacherOpenId", kind, "startAt");

commit;
