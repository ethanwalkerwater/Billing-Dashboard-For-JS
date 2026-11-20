begin;
set local lock_timeout='5s';

-- Preserve exactly which scheduled lessons contributed to the daily finding, without copying student details.
create or replace view public.fupan_missing_days as
with schedule as (
  select distinct x->>0 id,(x->>1)::bigint starts,(x->>2)::bigint ends
  from public.wb_cache c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.data->'rows')='array' and c.key like 'm:%' then c.data->'rows' else '[]' end) x
  where c.key between 'm:2026-11' and ('m:'||to_char(now() at time zone 'Asia/Shanghai','YYYY-MM'))
    and c.data->>'h'<>'' and x->>0 ~ '^rec[A-Za-z0-9]+$' and x->>1 ~ '^[0-9]{13}$' and x->>2 ~ '^[0-9]{13}$'
    and x->>1 >= '1794326400000' and x->>2 <= least(c."syncedAt",(extract(epoch from now())*1000)::bigint-7200000)::text
    and x->>2 > x->>1 and coalesce(x->>9,'')='' and coalesce(x->>8,'') !~ '会议'
    and coalesce(x->>5,'') !~ '会议|咨询|到访|对接会|考试|模考|模测|^(空出|可排课|休息|请假|春节假期|课表确定|准备)$'
    and (jsonb_array_length(case when jsonb_typeof(x->3)='array' then x->3 else '[]' end)>0 or coalesce(x->>4,'')<>'')
), missing as (
  select s.*,to_char(to_timestamp(starts/1000.0) at time zone 'Asia/Shanghai','YYYY-MM-DD') as day_key
  from schedule s left join public.classroom_lessons l on l."_id"=s.id
  where l."_id" is null or (l.stage='empty' and l."audioDeletedAt" is null and coalesce(l."audioSec",0)=0 and l."mergedFileId" is null and l.transcript is null)
)
select ('missing-'||day_key) as lesson_id,
  encode(sha256(convert_to(string_agg(id,',' order by id),'UTF8')),'hex') as source_hash,
  day_key,min(starts) as starts,count(*) as n,
  jsonb_agg(jsonb_build_object('lessonId',id,'startAt',starts) order by id) as members
from missing group by day_key;

alter table public.fupan_decisions add column snapshot jsonb;
-- Decisions predating this migration retain the original analysis when it is still recoverable.
with known as (
  select i.*, coalesce(m.members,'[]'::jsonb) as "relatedLessons" from public.fupan_issues i
  left join public.fupan_missing_days m on i."findingId"='rule-missing'
    and (m.lesson_id,m.source_hash)=(i."lessonId",i."sourceHash")
  union all select p.*,'[]'::jsonb from public.fupan_previous_issues p
)
update public.fupan_decisions d set snapshot=to_jsonb(k)-array['state','result','owner','note','history']
from known k where (d.lesson_id,d.source_hash,d.version,d.finding_id)=(k."lessonId",k."sourceHash",k.version,k."findingId");

-- An already-disappeared legacy rule has no stored evidence. Keep the judgment and mark the gap explicitly.
update public.fupan_decisions set snapshot=jsonb_build_object(
  'category',case finding_id when 'rule-missing' then '录音缺失' when 'rule-overtime' then '课堂时间'
    when 'rule-offtopic' then '非教学用时' when 'rule-management' then '课堂管理' else '课堂内容' end,
  'priority','一般','title','原始依据未留存','check','本条人工记录早于证据快照功能，历史原文无法还原。',
  'evidence','[]'::jsonb,'relatedLessons','[]'::jsonb) where snapshot is null;
alter table public.fupan_decisions alter column snapshot set not null;

-- A lesson reclassified as a meeting, merged, or moved outside the pilot must lose supervisor visibility.
create view public.fupan_scoped_decisions as
select d.* from public.fupan_decisions d
where (d.finding_id='rule-missing' and d.lesson_id ~ '^missing-[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  or exists (select 1 from public.classroom_lessons l where l."_id"=d.lesson_id
    and l."startAt">=1794326400000 and coalesce(l.kind,'lesson') in ('lesson','adhoc'));
revoke all on public.fupan_scoped_decisions from public,anon,authenticated;
grant select on public.fupan_scoped_decisions to service_role;

create or replace view public.fupan_previous_issues as
select d.lesson_id as "lessonId",d.source_hash as "sourceHash",d.version,d.finding_id as "findingId",
  s."teacherOpenId",s."teacherName",s.course,s."startAt",s.category,s.priority,s.title,s."check",s.evidence,
  d.state,d.result,d.owner,d.note,d.history,true as historical,d.snapshot->'relatedLessons' as "relatedLessons"
from public.fupan_scoped_decisions d
cross join lateral jsonb_populate_record(null::public.fupan_ai_issues,d.snapshot) s
where not exists (select 1 from public.fupan_issues i where
  (i."lessonId",i."sourceHash",i.version,i."findingId")=(d.lesson_id,d.source_hash,d.version,d.finding_id));

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
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'rank' order by rank desc,
    "startAt" desc nulls last,"lessonId","findingId",version desc,"sourceHash") from page p),'[]'::jsonb),
    'counts',jsonb_build_object('open',0,'follow',0,'closed',0) ||
      coalesce((select jsonb_object_agg(state,n) from counts),'{}'::jsonb),
    'total',coalesce((select n from counts where state=p_state),0),'page',p_page,'pageSize',25)
$$;

create or replace function public.fupan_decide(
  p_lesson text,p_hash text,p_version integer,p_finding text,p_action text,p_expected text,
  p_note text,p_owner text,p_actor text,p_by text
) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare saved jsonb; entry jsonb; next_state text; next_result text; next_owner text;
begin
  perform 1 from public.fupan_supervisors where open_id=p_actor for share;
  if not found then return '{"error":"forbidden"}'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_lesson,0));
  perform 1 from public.classroom_lessons where "_id"=p_lesson for update;
  entry:=jsonb_build_object('action',p_action,'at',clock_timestamp(),'by',p_by,'actorId',p_actor,'note',p_note);

  if p_action='close' then
    if p_expected<>'follow' or coalesce(btrim(p_note),'')='' then return '{"error":"invalid"}'; end if;
    -- A follow-up belongs to the original human decision, even when its source is gone.
    update public.fupan_decisions set state='closed',note=p_note,
      history=history || jsonb_build_array(entry || jsonb_build_object('owner',owner))
    where (lesson_id,source_hash,version,finding_id)=(p_lesson,p_hash,p_version,p_finding) and state='follow'
      and exists (select 1 from public.fupan_scoped_decisions s
        where (s.lesson_id,s.source_hash,s.version,s.finding_id)=(p_lesson,p_hash,p_version,p_finding))
    returning result into next_result;
    if not found then return '{"error":"stale"}'; end if;
    return jsonb_build_object('ok',true,'state','closed','result',next_result);
  end if;

  if p_expected<>'open' or p_action not in ('confirm','refer','dismiss') or
     (p_finding='rule-missing' and p_action='confirm') or
     (p_action='refer' and coalesce(btrim(p_owner),'')='') or
     (p_action='dismiss' and coalesce(btrim(p_note),'')='') then return '{"error":"invalid"}'; end if;
  select (to_jsonb(i)-array['state','result','owner','note','history'])
      || jsonb_build_object('relatedLessons',coalesce(m.members,'[]'::jsonb)) into saved
  from public.fupan_issues i left join public.fupan_missing_days m on i."findingId"='rule-missing'
    and (m.lesson_id,m.source_hash)=(i."lessonId",i."sourceHash")
  where (i."lessonId",i."sourceHash",i.version,i."findingId")=(p_lesson,p_hash,p_version,p_finding)
    and i.state='open';
  if not found then return '{"error":"stale"}'; end if;
  next_owner:=case when p_action='dismiss' then '' else p_owner end;
  next_state:=case when p_action='refer' or (p_action='confirm' and next_owner<>'') then 'follow' else 'closed' end;
  insert into public.fupan_decisions(lesson_id,source_hash,version,finding_id,state,result,owner,note,history,snapshot)
    values(p_lesson,p_hash,p_version,p_finding,next_state,p_action,next_owner,p_note,
      jsonb_build_array(entry || jsonb_build_object('owner',next_owner)),saved)
    on conflict (lesson_id,source_hash,version,finding_id) do nothing;
  if not found then return '{"error":"stale"}'; end if;
  return jsonb_build_object('ok',true,'state',next_state,'result',p_action);
end;
$$;

notify pgrst,'reload schema';
commit;
