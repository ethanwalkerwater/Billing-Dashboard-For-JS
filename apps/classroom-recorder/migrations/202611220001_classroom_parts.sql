-- 0.1.14 起 App 上课时分块直传：第一块申请上传地址时记下时间，App 没回来时云端靠它收尾
alter table public.classroom_lessons
  add column if not exists "partsAt" bigint;
