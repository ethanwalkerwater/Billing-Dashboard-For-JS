begin;

-- 实际录音时长（秒）：合并时按收到的分段字节数算（MP3 32 kbps 恒定码率 = 4000 字节/秒）。
-- endAt - startAt 是课表时间，App 中途停录、晚开录时和真实录音对不上。
alter table public.classroom_lessons add column if not exists "audioSec" integer;
update public.classroom_lessons l set "audioSec" = s.sec
  from (select "lessonId", round(sum(bytes) / 4000.0)::int as sec from public.classroom_segments group by "lessonId") s
  where s."lessonId" = l."_id" and l.stage <> 'recording' and l."audioSec" is null;

-- 后台表头筛选的候选项：老师 × 学生去重
create or replace view public.classroom_lesson_people as
  select distinct "teacherName", student from public.classroom_lessons;
revoke all on public.classroom_lesson_people from anon, authenticated;

commit;
