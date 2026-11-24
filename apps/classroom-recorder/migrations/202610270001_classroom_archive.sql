-- 课堂时间档案：整节课按环节切好（含课前、闲聊、课间），程序检查过，家长报告和后台的所有时间都从这里算。
-- 只有后台能看全；公开报告接口只带出算好的分钟数。会议没有档案。
alter table public.classroom_lessons add column if not exists archive jsonb;
