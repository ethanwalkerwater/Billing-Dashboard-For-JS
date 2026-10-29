begin;

-- 不算录制：录音不到 5 分钟且几乎没人说话（stage = empty），不调模型、不出总结，App 里当作没录
alter table public.classroom_lessons drop constraint if exists classroom_lessons_stage_check;
alter table public.classroom_lessons add constraint classroom_lessons_stage_check check (stage in ('recording', 'queued', 'transcribing', 'summarizing', 'done', 'failed', 'empty'));

commit;
