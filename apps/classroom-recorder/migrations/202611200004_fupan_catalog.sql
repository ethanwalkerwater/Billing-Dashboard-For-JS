begin;
set local lock_timeout='5s';

-- 教学标签依附于飞书老师档案，同名老师的记录分开保存。
create table public.fupan_teacher_profiles (
  teacher_id text primary key,
  record_id text not null unique,
  name text not null,
  schedule_name text not null,
  subject text not null default '',
  grade text not null,
  classes text[] not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
create table public.fupan_lesson_metrics (
  lesson_id text primary key references public.classroom_lessons("_id") on delete cascade,
  metrics jsonb
);
alter table public.fupan_teacher_profiles enable row level security;
alter table public.fupan_lesson_metrics enable row level security;
revoke all on public.fupan_teacher_profiles, public.fupan_lesson_metrics from public, anon, authenticated;
grant select, insert, update on public.fupan_teacher_profiles, public.fupan_lesson_metrics to service_role;
grant delete on public.fupan_lesson_metrics to service_role;

-- 每份转写只计算一次。未知说话人不能据以推断老师讲话占比。
create function public.fupan_metrics(transcript_text text, audio_seconds integer)
returns jsonb language plpgsql immutable strict parallel safe set search_path=pg_catalog as $$
declare
  max_seconds constant int := 86400;
  t int[] := '{}'; s int[] := '{}';
  m text[]; a int; b int; i int; n int; d int; overlap int; seconds_t int:=0;
  known boolean:=false; unknown boolean:=false; max_end int:=0;
  tw int:=0; changes int:=0; last_t boolean; is_t boolean; longest int:=0; run int:=0;
  questions int:=0; open_q int:=0; rt numeric; ch numeric;
begin
  for m in select regexp_matches(transcript_text,
    '^\[([^]]+) ([0-9]{1,4}):([0-5][0-9])-([0-9]{1,4}):([0-5][0-9])\][[:blank:]]*([^\r\n]*)','gn') loop
    a := m[2]::int*60+m[3]::int; b := m[4]::int*60+m[5]::int;
    if b<a or b>max_seconds then return null; end if;
    b := greatest(b,a+1);
    max_end := greatest(b,max_end);
    if m[1]='老师' then
      known := true;
      if rtrim(m[6]) ~ '[?？]$' then
        questions:=questions+1;
        if m[6] ~* '为什么|怎么|如何|什么意思|还有什么|\m(why|how)\M' then open_q:=open_q+1; end if;
      end if;
    elsif m[1]='学生' then known := true;
    else unknown := true;
    end if;
    for i in (a/30)+1 .. ((b-1)/30)+1 loop
      overlap:=least(b,30*i)-greatest(a,30*(i-1));
      if m[1]='老师' then t[i]:=coalesce(t[i],0)+overlap;
      else s[i]:=coalesce(s[i],0)+overlap; end if;
    end loop;
  end loop;
  if not known or unknown or max_end=0 then return null; end if;
  d:=greatest(max_end,audio_seconds);
  if d>max_seconds then return null; end if;
  n:=(d+29)/30;
  for i in 1..n loop
    is_t:=coalesce(t[i],0)>=5 and coalesce(t[i],0)>coalesce(s[i],0);
    seconds_t:=seconds_t+least(coalesce(t[i],0),least(30,d-(i-1)*30));
    if is_t then tw:=tw+1; run:=run+least(30,d-(i-1)*30); longest:=greatest(longest,run);
    else run:=0; end if;
    if last_t<>is_t then changes:=changes+1; end if;
    last_t:=is_t;
  end loop;
  rt:=tw::numeric/n; ch:=changes::numeric/n;
  return jsonb_build_object('mode',case when rt>=0.7 then '讲授型' when rt<=0.3 then '练习型'
    when ch>=0.4 then '对话型' else '混合型' end,'rt',round(rt,3),'ch',round(ch,3),
    'talkRatio',round(seconds_t::numeric/d,3),'questions',questions,'openQuestions',open_q,'longestLectureSec',longest);
end;
$$;

create function public.fupan_store_metrics() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' and old.transcript is not distinct from new.transcript and old."audioSec" is not distinct from new."audioSec"
    and old.kind is not distinct from new.kind and old."startAt"=new."startAt" then return new; end if;
  if new."startAt">=1794326400000 and coalesce(new.kind,'lesson') in ('lesson','adhoc') and nullif(new.transcript,'') is not null then
    insert into public.fupan_lesson_metrics values (new."_id",public.fupan_metrics(new.transcript,coalesce(new."audioSec",0)))
    on conflict (lesson_id) do update set metrics=excluded.metrics;
  else delete from public.fupan_lesson_metrics where lesson_id=new."_id"; end if;
  return new;
end;
$$;
create trigger fupan_metrics_changed after insert or update of transcript,"audioSec",kind,"startAt" on public.classroom_lessons
  for each row execute function public.fupan_store_metrics();
insert into public.fupan_lesson_metrics
  select "_id",public.fupan_metrics(transcript,coalesce("audioSec",0)) from public.classroom_lessons
  where "startAt">=1794326400000 and coalesce(kind,'lesson') in ('lesson','adhoc') and nullif(transcript,'') is not null;
revoke all on function public.fupan_metrics(text,integer), public.fupan_store_metrics() from public,anon,authenticated;
grant execute on function public.fupan_metrics(text,integer) to service_role;

create view public.fupan_catalog_identities as
  select id,array_agg(distinct name) as aliases from (
    select distinct "teacherOpenId" id,"teacherName" name from public.classroom_lessons where coalesce(kind,'lesson') in ('lesson','adhoc')
    union all select "openId", "scheduleName" from public.classroom_sessions
    union all select teacher_id, schedule_name from public.fupan_teacher_profiles
    union all select teacher_id, name from public.fupan_teacher_profiles
  ) a where name<>'' group by id;
create view public.fupan_catalog_notes as
  select n.*,l."teacherOpenId" as "teacherId",l."startAt" from public.fupan_lesson_notes n
    join public.classroom_lessons l on l."_id"=n."lessonId";
create function public.fupan_scheduled_lesson(p_id text)
returns table ("row" jsonb) language sql stable set search_path=pg_catalog,public as $$
  select x from public.wb_cache c cross join lateral jsonb_array_elements(c.data->'rows') x
    where c.key like 'm:%' and c."syncedAt">0 and c.data->>'h'<>''
    and x->>0=p_id and (x->>1)::bigint>=1794326400000 order by c."syncedAt" desc limit 1;
$$;
create view public.fupan_catalog_lessons as
  select l."_id" as id,l."teacherOpenId" as "teacherId",l."teacherName",l.student,l.course,l."startAt",l."endAt",l.stage,
    l."audioSec",l."audioDeletedAt" is not null as "audioDeleted",l."mergedFileId" is not null as "audioPresent",
    m.lesson_id is not null as "hasTranscript",m.metrics,r.status as "reviewStatus",
    summary.pending,summary.confirmed,summary."firstIssue",
    coalesce((select jsonb_agg(jsonb_build_object('start',x->'start','end',x->'end','kind',x->'kind') order by ord)
      from jsonb_array_elements(case when jsonb_typeof(l.archive->'segments')='array' then l.archive->'segments' else '[]' end)
        with ordinality as seg(x,ord)),'[]'::jsonb) as "miniSegments"
  from public.classroom_lessons l
  cross join lateral (
    select count(*) filter (where i.state='open')::int as pending, count(*) filter (where i.result='confirm')::int as confirmed,
      (jsonb_agg(jsonb_build_object('category',i.category,'priority',i.priority,'title',i.title,'state',i.state,
        'evidence',case when i.evidence->0 is not null then jsonb_build_array(i.evidence->0) else '[]'::jsonb end)
        order by case i.state when 'open' then 1 when 'follow' then 2 else 3 end,
          case i.priority when '紧急' then 1 when '重要' then 2 else 3 end,i."findingId")->0) as "firstIssue"
    from public.fupan_issues i where i."lessonId"=l."_id" and i."teacherOpenId"<>''
  ) summary
  left join public.fupan_lesson_metrics m on m.lesson_id=l."_id"
  left join public.fupan_current_reviews r on r.lesson_id=l."_id"
  where l."startAt">=1794326400000 and coalesce(l.kind,'lesson') in ('lesson','adhoc');

-- 把快照里的课和录音按课表编号合并；没有录音时只在课表名对应唯一老师时归户。
create function public.fupan_schedule(p_month text, p_from bigint, p_to bigint, p_id text default null)
returns table (rows jsonb, "syncedAt" bigint) language sql stable set search_path=pg_catalog,public as $$
  select coalesce((select jsonb_agg(x) from jsonb_array_elements(c.data->'rows') x
    where (x->>1)::bigint >= p_from and (x->>1)::bigint < p_to and (p_id is null or x->>0=p_id)), '[]'::jsonb), c."syncedAt"
  from public.wb_cache c where c.key='m:'||p_month and c."syncedAt">0 and c.data->>'h'<>'';
$$;
-- 本学期按课程归属汇总。仅本月编号数组用于与课表快照去重。
create function public.fupan_teacher_stats(p_term bigint, p_month bigint, p_now bigint)
returns table (id text,name text,aliases text[], "monthIds" text[], courses text[], modes jsonb,
  "medianTalkRatio" numeric, pending bigint, confirmed bigint) language sql stable set search_path=pg_catalog,public as $$
  with term as materialized (
    select l."teacherOpenId" as "teacherId",m.metrics
      from public.classroom_lessons l join public.fupan_lesson_metrics m on m.lesson_id=l."_id"
      where l."startAt" between p_term and p_now and coalesce(l.kind,'lesson') in ('lesson','adhoc')
  ), people as (
    select "teacherOpenId" as id,(array_agg("teacherName" order by "startAt" desc))[1] as name,
      array_agg(distinct "teacherName") as names,
      array_agg(distinct "_id") filter(where "startAt">=p_month and (coalesce("audioSec",0)>0 or nullif("mergedFileId",'') is not null or "audioDeletedAt" is not null or stage='done')) as recorded,
      array_agg(distinct course) filter(where course<>'') as courses
    from public.classroom_lessons where "startAt" between least(p_term,p_month) and p_now and coalesce(kind,'lesson') in ('lesson','adhoc')
    group by "teacherOpenId"
  ), totals as (
    select "teacherId",
      (percentile_cont(0.5) within group (order by (metrics->>'talkRatio')::numeric))::numeric as median
    from term group by "teacherId"
  ), issue_counts as (
    select "teacherOpenId" as id,count(*) filter (where state='open') as pending,
      count(*) filter (where result='confirm') as confirmed
    from public.fupan_issues where "teacherOpenId"<>'' and "startAt" between p_term and p_now group by "teacherOpenId"
  ), mode_counts as (
    select "teacherId",metrics->>'mode' mode,count(*) as n from term where metrics is not null group by 1,2
  ), session_names as (
    select "openId",array_agg(distinct "scheduleName") as names from classroom_sessions group by "openId"
  )
  select p.id,p.name,p.names||coalesce(s.names,'{}'::text[]),coalesce(p.recorded,'{}'::text[]),p.courses,
    coalesce((select jsonb_object_agg(m.mode,m.n) from mode_counts m where m."teacherId"=p.id),'{}'::jsonb),
    t.median,coalesce(i.pending,0),coalesce(i.confirmed,0)
  from people p left join totals t on t."teacherId"=p.id left join session_names s on s."openId"=p.id left join issue_counts i on i.id=p.id;
$$;
revoke all on public.fupan_catalog_lessons, public.fupan_catalog_notes, public.fupan_catalog_identities from public,anon,authenticated;
grant select on public.fupan_catalog_lessons, public.fupan_catalog_notes, public.fupan_catalog_identities to service_role;
revoke all on function public.fupan_scheduled_lesson(text), public.fupan_schedule(text,bigint,bigint,text), public.fupan_teacher_stats(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.fupan_scheduled_lesson(text), public.fupan_schedule(text,bigint,bigint,text), public.fupan_teacher_stats(bigint,bigint,bigint) to service_role;
-- 周视图只读日计数所需的元数据。逐句证据、时间档案只随选定日期加载。
create function public.fupan_week(p_from bigint, p_to bigint)
returns table (id text, "teacherId" text, "teacherName" text, course text, student text, "startAt" bigint,
  analyzed boolean, pending bigint, flagged boolean) language sql stable set search_path=pg_catalog,public as $$
  with issues as (
    select "lessonId",count(*) filter(where state in ('open','follow')) as pending
    from public.fupan_issues where "teacherOpenId"<>'' and "startAt">=p_from and "startAt"<p_to group by "lessonId"
  )
  select l."_id",l."teacherOpenId",l."teacherName",l.course,l.student,l."startAt",coalesce(r.status='done',false),
    coalesce(i.pending,0),i."lessonId" is not null
  from public.classroom_lessons l
  left join public.fupan_current_reviews r on r.lesson_id=l."_id"
  left join issues i on i."lessonId"=l."_id"
  where l."startAt">=greatest(p_from,1794326400000) and l."startAt"<p_to and coalesce(l.kind,'lesson') in ('lesson','adhoc')
  order by l."startAt",l."_id";
$$;
create function public.fupan_random(p_teacher text default null)
returns table (id text) language sql volatile set search_path=pg_catalog,public as $$
  select l."_id" from public.classroom_lessons l
  join public.fupan_lesson_metrics m on m.lesson_id=l."_id"
  where coalesce(l.kind,'lesson') in ('lesson','adhoc') and l."startAt">=1794326400000
    and l."startAt"<=extract(epoch from now())*1000 and l."startAt">extract(epoch from now()-interval '30 days')*1000 and l."audioDeletedAt" is null
    and l."mergedFileId" in (l."_id"||'/merged.mp3',l."_id"||'/early.mp3')
    and (p_teacher is null or l."teacherOpenId"=p_teacher)
  order by random() limit 1;
$$;
revoke all on function public.fupan_week(bigint,bigint),public.fupan_random(text) from public,anon,authenticated;
grant execute on function public.fupan_week(bigint,bigint),public.fupan_random(text) to service_role;
notify pgrst,'reload schema';
commit;
