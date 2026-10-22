begin;

-- 官网「课堂体验」：每个课程月份每位老师三项偏好的「偏右侧选择 × 课时」和、课时和、份数（functions/feedback-score/index.py preferences），
-- 官网接口把已定稿月份逐月相加（src/server/site/teacher-stats.ts）。
alter table public.feedback_score_results add column if not exists preferences jsonb not null default '{}'::jsonb;

commit;
