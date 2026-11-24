begin;

-- 会议纪要提示词（后台第四栏）；之前保存的版本为空，云函数读取时用代码里的默认补上
alter table public.classroom_prompts add column if not exists meeting text;

commit;
