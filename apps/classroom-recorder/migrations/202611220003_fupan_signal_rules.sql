begin;
set local lock_timeout='5s';

create or replace function public.fupan_timing_candidates(segments jsonb, kind text, started text, end_ms bigint)
returns table(finding_id text,category text,title text,rationale text,evidence jsonb,source_hash text)
language sql stable set search_path=pg_catalog as $$
 with spans as (
   select s->>'kind' as k, left(coalesce(s->>'title',''),120) as caption,
     (s->>'start')::numeric as a, (s->>'end')::numeric as b
   from jsonb_array_elements(case when jsonb_typeof(segments)='array' then segments else '[]' end) s
   where jsonb_typeof(s->'start')='number' and jsonb_typeof(s->'end')='number'
 ), usable as (
   select *, k in ('课堂交流','非教学') and
     caption !~ '暂停|课前|课后|休息|学习规划|学业规划|选课|作业安排|作业布置|布置作业|讲解作业' as off_topic
   from spans where a>=0 and b>a and b<=86400 and k not in ('课前','课后','课间休息','休息','暂停') and caption !~ '^(暂停|课间休息|课前准备|课后交流)'
 ), summary as (
   select min(a) as first_at,max(b) as last_at,
     sum(b-a) filter(where off_topic) as chat,
     sum(b-a) filter(where k='课堂管理') as discipline from usable
 ), clock as (
   select case when kind='lesson' and started ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
     and pg_input_is_valid(started,'timestamptz') then extract(epoch from started::timestamptz) end as origin
 ), candidates as (
   select 'rule-overtime' as id,'课堂时间' as cat,
     '最后一个课堂环节比排课结束晚 '||floor((origin+last_at-end_ms/1000.0)/60)::text||' 分钟' as heading,
     '按实际录音开始时间和课表结束时间估算，请核对调课、延时开课和课后交流。' as detail,
     last_at-1 as marker,last_at as stop,'最后一个课堂环节结束' as label
   from summary,clock where origin+last_at-end_ms/1000.0 between 300 and 86400
   union all
   select 'rule-offtopic','非教学用时','时间档案标为非教学的环节累计 '||round(chat/60)::text||' 分钟',
     '已扣除档案标明的休息、暂停和学习规划。请回听判断是否为课程安排或与教学相关的交流。',a,b,caption
   from summary cross join lateral (select * from usable where off_topic order by b-a desc,a limit 1) longest
   where chat>600
   union all
   select 'rule-management','课堂管理','档案中课堂管理用时占 '||round(100*discipline/nullif(last_at-first_at,0))::text||'%',
     '依据标为课堂管理的环节，请核对是否需要带教支持。',a,b,caption
   from summary cross join lateral (select * from usable where k='课堂管理' order by b-a desc,a limit 1) longest
   where discipline>(last_at-first_at)*0.25
 ), marked as (
   select id,cat,heading,detail,jsonb_build_array(jsonb_build_object('start',floor(marker),'end',ceil(stop),
     'speaker','时间档案','text',label)) as ev from candidates
 )
 select id,cat,heading,detail,ev,encode(sha256(convert_to(jsonb_build_array(id,heading,ev)::text,'UTF8')),'hex') from marked
$$;

-- Recalculate timing metadata for pilot archives. Only changed rule rows are written; existing evidence keys stay stable.
lock table public.fupan_timing_rules in share row exclusive mode;
create temporary table fupan_timing_revised on commit drop as
select l."_id" as lesson_id,t.* from public.classroom_lessons l
cross join lateral public.fupan_timing_candidates(l.archive->'segments',coalesce(l.kind,'lesson'),l.finish->>'startedAt',l."endAt") t
where l."startAt">=1794326400000 and coalesce(l.kind,'lesson') in ('lesson','adhoc') and l.archive is not null
  and l.archive->'segments' is not null;
delete from public.fupan_timing_rules old where not exists (select from fupan_timing_revised r
  where (r.lesson_id,r.finding_id)=(old.lesson_id,old.finding_id));
insert into public.fupan_timing_rules as old select * from fupan_timing_revised
on conflict (lesson_id,finding_id) do update set (category,title,rationale,evidence,source_hash)=
  (excluded.category,excluded.title,excluded.rationale,excluded.evidence,excluded.source_hash)
where (old.source_hash,old.rationale) is distinct from (excluded.source_hash,excluded.rationale);

-- Evidence intervals are already validated by both the model decoder and the timing extractor.
create function public.fupan_overlaps_clock(timing jsonb, utterances jsonb)
returns boolean language sql immutable strict parallel safe set search_path=pg_catalog as $$
  select exists(select from jsonb_array_elements(utterances) v
    where (v->>'start')::numeric < (timing#>>'{0,end}')::numeric
      and greatest((v->>'end')::numeric,(v->>'start')::numeric+0.001) > (timing#>>'{0,start}')::numeric)
$$;
revoke all on function public.fupan_overlaps_clock(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fupan_overlaps_clock(jsonb,jsonb) to service_role;

create or replace view public.fupan_ai_issues as
select r.lesson_id as "lessonId", r.source_hash as "sourceHash", r.version, f->>'id' as "findingId",
  l."teacherOpenId",l."teacherName",l.course,l."startAt", case
    when d.snapshot->>'category' is not null then d.snapshot->>'category'
    when r.version<>1 or f->>'priority'='紧急' then f->>'category'
    when f->>'category'='课堂惩戒' then '纪律处理'
    when f->>'category'='粗俗表达' then '课堂用语'
    else '旧版·'||(f->>'category') end as category,
  f->>'priority' as priority,f->>'title' as title,case when r.version=1 and f->>'priority'<>'紧急' and d.lesson_id is null
    then '旧版识别，须结合原话与上下文核实。' || coalesce(f->>'check','')
    else f->>'check' end as "check" ,f->'evidence' as evidence,
  coalesce(d.state,'open') as state, d.result,coalesce(d.owner,'') as owner,coalesce(d.note,'') as note,
  coalesce(d.history,'[]'::jsonb) as history
from public.fupan_current_reviews r
join public.classroom_lessons l on l."_id"=r.lesson_id
cross join lateral jsonb_array_elements(r.findings) f
left join public.fupan_decisions d on (d.lesson_id,d.source_hash,d.version,d.finding_id)
  = (r.lesson_id,r.source_hash,r.version,f->>'id')
where r.status='done' and (r.version<>2 or d.lesson_id is not null or not exists (
  select from public.fupan_decisions prior where
    (prior.lesson_id,prior.source_hash,prior.version,prior.finding_id)=(r.lesson_id,r.source_hash,1,f->>'id')
)) and not (
  r.version>=2 and d.lesson_id is null and f->>'category'='课堂时间使用' and exists (
    select from public.fupan_timing_rules t join public.fupan_decisions decision
      on (decision.lesson_id,decision.source_hash,decision.version,decision.finding_id)=(t.lesson_id,t.source_hash,1,t.finding_id)
    where t.lesson_id=r.lesson_id and public.fupan_overlaps_clock(t.evidence,f->'evidence')
  )
);

-- Keep an adjudicated group's original membership. Regrouping can never reopen an already
-- reviewed missing lesson. If its roster changes it stays available through the existing snapshot.
create or replace view public.fupan_missing_days as
with timetable as (
  select distinct on (x->>0) x->>0 id, (x->>1)::bigint starts, (x->>2)::bigint ends,
    btrim(x->>6) teacher, x, c."syncedAt" synced
  from public.wb_cache c cross join lateral jsonb_array_elements(case when c.key like 'm:%'
    and jsonb_typeof(c.data->'rows')='array' then c.data->'rows' else '[]' end) x
  where c.key between 'm:2026-11' and ('m:'||to_char(now() at time zone 'Asia/Shanghai','YYYY-MM'))
    and c.data->>'h'<>'' and x->>0 ~ '^rec[A-Za-z0-9]+$' and x->>1 ~ '^[0-9]{13}$' and x->>2 ~ '^[0-9]{13}$'
  order by x->>0,c."syncedAt" desc,c.key desc
), aliases as (
  select name,min(id) as id from public.fupan_catalog_identities identities cross join unnest(identities.aliases) name
  group by name having count(distinct id)=1
), courses as (
  select t.id,t.starts,coalesce(nullif(l."teacherOpenId",''),a.id) as teacher_id,t.teacher,
    l."_id" is null or (l.stage='empty' and l."audioDeletedAt" is null and coalesce(l."audioSec",0)=0
      and l."mergedFileId" is null and l.transcript is null and l.archive is null and l."asrTaskId" is null) as absent
  from timetable t left join public.classroom_lessons l on l."_id"=t.id left join aliases a on a.name=t.teacher
  where t.starts>=1794326400000 and t.ends>t.starts and t.ends<=least(t.synced,(extract(epoch from now())*1000)::bigint-7200000)
    and coalesce(t.x->>9,'')='' and coalesce(t.x->>8,'') !~ '会议'
    and coalesce(t.x->>5,'') !~ '会议|咨询|到访|对接会|考试|模考|模测|^(空出|可排课|休息|请假|春节假期|课表确定|准备)$'
    and (jsonb_array_length(case when jsonb_typeof(t.x->3)='array' then t.x->3 else '[]' end)>0 or coalesce(t.x->>4,'')<>'')
  union all
  -- An actual unscheduled lesson between two missing schedules interrupts the run.
  select l."_id",l."startAt",l."teacherOpenId",l."teacherName",false from public.classroom_lessons l
    where l."startAt" between 1794326400000 and (extract(epoch from now())*1000)::bigint and coalesce(l.kind,'lesson') in ('lesson','adhoc')
      and (l."audioDeletedAt" is not null or l."audioSec">0 or l.archive is not null or l.transcript is not null or l."mergedFileId" is not null)
      and not exists(select from timetable t where t.id=l."_id")
), numbered as (
  select *,count(*) filter(where not absent) over(partition by teacher_id order by starts,id rows unbounded preceding) as run
  from courses
), missing as (
  select *,to_char(to_timestamp(starts/1000.0) at time zone 'Asia/Shanghai','YYYY-MM-DD') as day,
    teacher_id is not null and count(*) over(partition by teacher_id,run)>1 as repeated
  from numbered where absent
), handled as (
  select d.lesson_id,d.source_hash,d.snapshot,member->>'lessonId' as id
  from public.fupan_decisions d cross join lateral jsonb_array_elements(d.snapshot->'relatedLessons') member
  where d.finding_id='rule-missing'
), packets as (
  select max(m.day) as day_key,max(m.starts) as starts,count(*) as n,
    encode(sha256(convert_to(string_agg(m.id,',' order by m.id),'UTF8')),'hex') as source_hash,
    jsonb_agg(jsonb_build_object('lessonId',m.id,'startAt',m.starts) order by m.starts,m.id) as members,
    case when m.repeated then '重要' else '一般' end as priority,case when m.repeated then min(m.teacher) end as who
  from missing m where not exists(select from handled h where h.id=m.id)
  group by m.repeated,case when m.repeated then m.teacher_id else m.day end,case when m.repeated then m.run end
)
select 'missing-'||p.day_key as lesson_id,p.source_hash,p.day_key,p.starts,p.n,p.members,p.priority,p.who
from packets p
union all
select h.lesson_id,h.source_hash,substring(h.lesson_id from 9), min(m.starts), count(*),
  jsonb_agg(jsonb_build_object('lessonId',m.id,'startAt',m.starts) order by m.starts,m.id),
  h.snapshot->>'priority',h.snapshot->>'teacherName'
from handled h left join missing m using(id)
group by h.lesson_id,h.source_hash,h.snapshot
having count(m.id)=count(*);

create or replace view public.fupan_rule_issues as
with recorded as not materialized (
  select l.* from public.classroom_lessons l
  where l."startAt">=1794326400000 and coalesce(l.kind,'lesson') in ('lesson','adhoc')
    and l."startAt">(extract(epoch from now())*1000)::bigint-2592000000 and l."audioDeletedAt" is null
    and l."mergedFileId" in (l."_id"||'/merged.mp3',l."_id"||'/early.mp3')
    and l."audioSec">=300 and l."asrTaskId">0
), complete_audio as (
  -- Only the complete MP3 manifest records a second byte count. Older segment-only estimates
  -- and early uploads cannot prove a seek is outside the track.
  select l."_id", l."audioSec", case when l.finish->>'startedAt' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
      and l.finish->>'endedAt' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
      and pg_input_is_valid(l.finish->>'startedAt','timestamptz') and pg_input_is_valid(l.finish->>'endedAt','timestamptz')
    then extract(epoch from ((l.finish->>'endedAt')::timestamptz - (l.finish->>'startedAt')::timestamptz)) end as wall
  from recorded l where l.stage='done' and l."mergedFileId"=l."_id"||'/merged.mp3' and l."gapMinutes"=0
    and coalesce(l.finish->'pauses','[]'::jsonb)='[]'::jsonb
    and l.finish#>>'{audio,sha256}' ~ '^[0-9a-f]{64}$'
    and round(case when jsonb_typeof(l.finish#>'{audio,bytes}')='number'
      then (l.finish#>>'{audio,bytes}')::numeric end/4000)=l."audioSec"
), bad_offsets as (
  select r.lesson_id,r.source_hash,earliest.offset_sec, l."audioSec"
  from complete_audio l join public.fupan_current_reviews r on r.lesson_id=l."_id"
  cross join lateral (
    select min((e->>'start')::numeric) as offset_sec
    from jsonb_array_elements(r.findings) f cross join lateral jsonb_array_elements(f->'evidence') e
    where case when jsonb_typeof(e->'start')='number' then (e->>'start')::numeric end
      >greatest(l."audioSec",l.wall)+greatest(120,0.02*l."audioSec")
  ) earliest
  where r.version=2 and r.status='done' and abs(l.wall-l."audioSec")<=60 and earliest.offset_sec is not null
), candidates as (
  select t.lesson_id,t.source_hash,t.finding_id,l."teacherOpenId",l."teacherName",l.course,l."startAt",
    '课堂时间使用'::text as category,'一般'::text as priority,t.title,t.rationale,t.evidence
  from public.fupan_timing_rules t join public.classroom_lessons l on l."_id"=t.lesson_id
  union all
  select lesson_id,source_hash,'rule-missing','',coalesce(who,''),'课表与录音',starts,'录音与转写',priority,
    case when priority='重要' then '连续课程缺录，涉及 '||n||' 节待排查课程'
      else day_key||' 有 '||n||' 节已排课程未找到录音' end,
    case when priority='重要' then '同一老师相邻的已结束课程连续缺录。'
      else '按天汇总单节异常。' end||'请核对列出的课程、设备和上传情况。','[]'::jsonb from public.fupan_missing_days
  union all
  select l."_id",encode(sha256(convert_to(jsonb_build_array('rule-transcript-missing',l."_id",l."mergedFileId",l."asrTaskId")::text,'UTF8')),'hex'),
    'rule-transcript-missing',l."teacherOpenId",l."teacherName",l.course,l."startAt",'录音与转写','一般','课程已有录音，未找到转写',
    '录音已提交转写，处理已结束。请检查转写任务并视情况补转。','[]'::jsonb
  from recorded l where (l.stage='done' or (l.stage='failed' and l.attempts>=3))
    and (l.transcript is null or octet_length(l.transcript)=0)
  union all
  select l."_id",encode(sha256(convert_to(jsonb_build_array('rule-audio-offset',b.source_hash,b.offset_sec,b."audioSec")::text,'UTF8')),'hex'),
    'rule-audio-offset',l."teacherOpenId",l."teacherName",l.course,l."startAt",'录音与转写','重要','复核片段的时间超出原音',
    '最早超出范围的片段从第 '||floor(b.offset_sec)::text||' 秒开始，整段原音约 '||b."audioSec"||' 秒。请核对转写时间轴。','[]'::jsonb
  from bad_offsets b join public.classroom_lessons l on l."_id"=b.lesson_id
)
select c.lesson_id as "lessonId",c.source_hash as "sourceHash",1 as version,c.finding_id as "findingId",
  c."teacherOpenId",c."teacherName",c.course,c."startAt",coalesce(d.snapshot->>'category',c.category) as category,
  coalesce(d.snapshot->>'priority',c.priority) as priority,coalesce(d.snapshot->>'title',c.title) as title,
  coalesce(d.snapshot->>'check',c.rationale) as "check",c.evidence,coalesce(d.state,'open') as state,d.result,
  coalesce(d.owner,'') as owner,coalesce(d.note,'') as note,coalesce(d.history,'[]'::jsonb) as history
from candidates c left join public.fupan_decisions d
  on (d.lesson_id,d.source_hash,d.version,d.finding_id)=(c.lesson_id,c.source_hash,1,c.finding_id)
where d.lesson_id is not null or c.category='录音与转写' or not exists (
  select from public.fupan_ai_issues a where a."lessonId"=c.lesson_id and a.version>=2
    and a.category='课堂时间使用' and public.fupan_overlaps_clock(c.evidence,a.evidence)
);

create or replace function public.fupan_inbox(p_state text,p_page integer) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
  with items as not materialized (
    select i.*,false as historical,null::jsonb as "relatedLessons" from public.fupan_issues i
    union all select * from public.fupan_previous_issues
  ), counts as (
    -- Every human decision is either current or historical; count it directly in both cases.
    select 'open' as state,count(*) as n from public.fupan_issues where state='open'
    union all select state,count(*) from public.fupan_scoped_decisions group by state
  ), page as (
    select i.*,case priority when '紧急' then 3 when '重要' then 2 else 1 end as rank
    from items i where state=p_state
    order by rank desc,"startAt" desc nulls last,"lessonId","findingId",version desc,"sourceHash" limit 25 offset ((p_page-1)*25)
  ), members as materialized (
    select m.lesson_id,m.source_hash,m.members from public.fupan_missing_days m
    where exists(select from page p where p."findingId"='rule-missing' and not p.historical)
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg((to_jsonb(p)-'rank') || case
      when m.members is not null then jsonb_build_object('relatedLessons',m.members) else '{}'::jsonb end
      order by p.rank desc,p."startAt" desc nulls last,p."lessonId",p."findingId",p.version desc,p."sourceHash")
      from page p left join members m on p."findingId"='rule-missing' and not p.historical
        and (m.lesson_id,m.source_hash)=(p."lessonId",p."sourceHash")),'[]'::jsonb),
    'counts',jsonb_build_object('open',0,'follow',0,'closed',0) ||
      coalesce((select jsonb_object_agg(state,n) from counts),'{}'::jsonb),
    'total',coalesce((select n from counts where state=p_state),0),'page',p_page,'pageSize',25)
$$;

notify pgrst,'reload schema';
commit;
