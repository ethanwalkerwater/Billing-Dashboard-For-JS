begin;

-- 取消记录里直接存课程描述，工作台列表不用再回读飞书课表
alter table public.cancel_intents add column if not exists lesson_label text;
alter table public.cancel_intents add column if not exists teacher_name text;
alter table public.cancel_intents add column if not exists lesson_start_at timestamptz;

create index if not exists cancel_intents_processed_idx on public.cancel_intents (processed_at desc);

commit;
