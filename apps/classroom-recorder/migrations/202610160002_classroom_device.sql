-- 同一节课只收第一台上传的电脑（见 functions/classroom-api claimDevice）
alter table public.classroom_lessons add column if not exists device text;
