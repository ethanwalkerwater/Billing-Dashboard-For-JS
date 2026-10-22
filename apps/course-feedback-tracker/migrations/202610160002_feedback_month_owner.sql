begin;

-- 每个月提前生成名单后，学生评价完这对学生-老师的课时就定稿：lessons 存生成名单时这几节课在课表快照里的行，
-- 有答卷后不再随课表更新，评分按它算权重（见 src/server/export/csv.ts applyFrozenLessons）。
alter table public.feedback_tasks add column if not exists lessons jsonb;

-- （这里原来还加了 feedback_tasks.owner，已由 202610160003 换成按月生效的 feedback_owner_assignments 并删掉）
alter table public.feedback_tasks add column if not exists owner text;

commit;
