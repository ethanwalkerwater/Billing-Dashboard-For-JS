begin;

-- 家长收集表：每个学生一个随机链接，家长不用登录，填完补进画像
alter table public.wb_students add column if not exists "formToken" text unique;
-- 交接卡：换老师后新老师确认看过，{课程: {teacher, at}}
alter table public.wb_students add column if not exists handover jsonb not null default '{}';

commit;
