-- 后台可以改转写（错字、说话人改名）：第一次改之前把机器转写原文留一份
alter table public.classroom_lessons add column if not exists "rawTranscript" text;
