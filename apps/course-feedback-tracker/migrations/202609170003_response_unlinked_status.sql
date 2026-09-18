begin;

-- 历史答卷（通过旧的公共分享链接填写）没有任务 ID，永远匹配不上任务。
-- 它们不是"异常"，是存量数据：单列成 unlinked，让异常列表只剩真正需要人工处理的。
alter table public.feedback_responses
  drop constraint if exists feedback_responses_sync_status_check;

alter table public.feedback_responses
  add constraint feedback_responses_sync_status_check
  check (sync_status in ('matched', 'duplicate', 'unlinked', 'exception'));

-- 按收集月份统计"本月收到多少份反馈"，这是教务最常看的数字。
alter table public.feedback_responses
  add column if not exists collection_month text;

create index if not exists feedback_responses_month_idx
  on public.feedback_responses (collection_month, sync_status);

commit;
