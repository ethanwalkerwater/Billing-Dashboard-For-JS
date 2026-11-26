begin;

-- 工作台「发布定稿」：课程月份过完后可以提前定稿（不等 M+2 月初自动定稿），记下谁在什么时候发布的。
-- 自动定稿的月份这两列为空。
alter table public.feedback_score_results add column if not exists published_at timestamptz;
alter table public.feedback_score_results add column if not exists published_by text;

commit;
