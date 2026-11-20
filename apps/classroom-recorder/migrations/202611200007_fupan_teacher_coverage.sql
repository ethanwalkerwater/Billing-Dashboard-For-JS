begin;
-- 只在打开老师详情时读取现有快照和录音元数据。缺月份时保留分子，分母返回空值。
create function public.fupan_teacher_coverage(p_teacher text,p_names text[],p_start bigint,p_now bigint)
returns table (recorded bigint,total bigint) language sql stable set search_path=pg_catalog,public as $$
  with months as (
    select 'm:'||to_char(m,'YYYY-MM') as key from generate_series(
      date_trunc('month',to_timestamp(p_start/1000.0) at time zone 'Asia/Shanghai'),
      date_trunc('month',to_timestamp(p_now/1000.0) at time zone 'Asia/Shanghai'), interval '1 month') m
  ), caches as (
    select c.data from months join public.wb_cache c using (key)
    where c."syncedAt">0 and c.data->>'h'<>'' and jsonb_typeof(c.data->'rows')='array'
  ), actual as (
    select "_id" as id,(coalesce("audioSec",0)>0 or nullif("mergedFileId",'') is not null
      or "asrTaskId" is not null or archive is not null) as recorded
    from public.classroom_lessons where "teacherOpenId"=p_teacher
      and coalesce(kind,'lesson') in ('lesson','adhoc') and "startAt" between p_start and p_now
  ), expected as (
    select x->>0 as id from caches cross join lateral jsonb_array_elements(data->'rows') x
    left join public.classroom_lessons l on l."_id"=x->>0
    where (x->>1)::bigint between p_start and p_now and x->>6=any(p_names)
      and coalesce(x->>9,'')='' and coalesce(x->>8,'') !~ '会议'
      and coalesce(x->>5,'') !~ '会议|咨询|到访|对接会|考试|模考|模测'
      and (l."_id" is null or (l."teacherOpenId"=p_teacher and coalesce(l.kind,'lesson') in ('lesson','adhoc')))
    union select id from actual
  )
  select (select count(*) from actual where recorded),
    case when (select count(*) from months)=(select count(*) from caches) then (select count(*) from expected) end;
$$;
revoke all on function public.fupan_teacher_coverage(text,text[],bigint,bigint) from public,anon,authenticated;
grant execute on function public.fupan_teacher_coverage(text,text[],bigint,bigint) to service_role;
notify pgrst,'reload schema';
commit;
