begin;
set local lock_timeout='5s';

-- 规则只用菁仕课堂已有的时间档案和课表快照，不调用模型。
create table public.fupan_timing_rules (
  lesson_id text not null references public.classroom_lessons("_id") on delete cascade,
  finding_id text not null,
  category text not null,
  title text not null,
  rationale text not null,
  evidence jsonb not null,
  source_hash text not null,
  primary key (lesson_id,finding_id)
);
alter table public.fupan_timing_rules enable row level security;
revoke all on public.fupan_timing_rules from public, anon, authenticated;
grant select,insert,delete on public.fupan_timing_rules to service_role;

create function public.fupan_timing_candidates(segments jsonb, kind text, started text, end_ms bigint)
returns table(finding_id text,category text,title text,rationale text,evidence jsonb,source_hash text)
language sql stable set search_path=pg_catalog as $$
 with spans as (
   select s->>'kind' as k, left(coalesce(s->>'title',''),120) as caption,
     (s->>'start')::numeric as a, (s->>'end')::numeric as b
   from jsonb_array_elements(case when jsonb_typeof(segments)='array' then segments else '[]' end) s
   where jsonb_typeof(s->'start')='number' and jsonb_typeof(s->'end')='number'
 ), usable as (
   select * from spans where a>=0 and b>a and b<=86400 and k not in ('课前','课后','课间休息')
 ), summary as (
   select min(a) as first_at,max(b) as last_at,
     sum(b-a) filter(where k in ('课堂交流','非教学') and caption !~ '^暂停') as chat,
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
     '已扣除暂停录制。请回听判断是否为课程安排或与教学相关的交流。',a,b,caption
   from summary cross join lateral (select * from usable where k in ('课堂交流','非教学') and caption !~ '^暂停' order by b-a desc,a limit 1) longest
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

create function public.fupan_store_timing_rules() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' and new.kind is not distinct from old.kind and new.archive is not distinct from old.archive
    and new.finish is not distinct from old.finish and new."startAt"=old."startAt" and new."endAt"=old."endAt" then return new; end if;
  delete from public.fupan_timing_rules where lesson_id=new."_id";
  if new."startAt">=1794326400000 and coalesce(new.kind,'lesson') in ('lesson','adhoc') and new.archive is not null then
    insert into public.fupan_timing_rules select new."_id",t.*
      from public.fupan_timing_candidates(new.archive->'segments',coalesce(new.kind,'lesson'),new.finish->>'startedAt',new."endAt") t;
  end if;
  return new;
end;
$$;
create trigger fupan_archive_rules after insert or update of archive,finish,kind,"startAt","endAt" on public.classroom_lessons
  for each row execute function public.fupan_store_timing_rules();
insert into public.fupan_timing_rules select l."_id",t.* from public.classroom_lessons l
cross join lateral public.fupan_timing_candidates(l.archive->'segments',coalesce(l.kind,'lesson'),l.finish->>'startedAt',l."endAt") t
where l."startAt">=1794326400000 and coalesce(l.kind,'lesson') in ('lesson','adhoc') and l.archive is not null;

-- 同一天缺录音在收件箱只占一行。快照在下课后确已同步才判缺；过期清理的原音始终算录过。
create view public.fupan_missing_days as
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
  day_key,min(starts) as starts,count(*) as n from missing group by day_key;

create view public.fupan_rule_issues as
with candidates as (
  select t.lesson_id,t.source_hash,t.finding_id,l."teacherOpenId",l."teacherName",l.course,l."startAt",
    t.category,t.title,t.rationale,t.evidence
  from public.fupan_timing_rules t join public.classroom_lessons l on l."_id"=t.lesson_id
  union all
  select lesson_id,source_hash,'rule-missing','','','当日课表与录音',starts,'录音缺失',
    day_key||' 有 '||n::text||' 节已排课程未找到录音','请查当天课程，核对调课、停课、设备或上传情况。','[]'::jsonb from public.fupan_missing_days
)
select c.lesson_id as "lessonId",c.source_hash as "sourceHash",1 as version,c.finding_id as "findingId",
  c."teacherOpenId",c."teacherName",c.course,c."startAt",c.category,'一般'::text as priority,
  c.title,c.rationale as "check",c.evidence,coalesce(d.state,'open') as state,d.result,
  coalesce(d.owner,'') as owner,coalesce(d.note,'') as note,coalesce(d.history,'[]'::jsonb) as history
from candidates c left join public.fupan_decisions d
  on (d.lesson_id,d.source_hash,d.version,d.finding_id)=(c.lesson_id,c.source_hash,1,c.finding_id);
create or replace view public.fupan_issues as
 select * from public.fupan_ai_issues union all select * from public.fupan_rule_issues;

revoke all on public.fupan_missing_days,public.fupan_rule_issues from public,anon,authenticated;
grant select on public.fupan_missing_days,public.fupan_rule_issues to service_role;
revoke all on function public.fupan_timing_candidates(jsonb,text,text,bigint),public.fupan_store_timing_rules() from public,anon,authenticated;
grant execute on function public.fupan_timing_candidates(jsonb,text,text,bigint) to service_role;
notify pgrst,'reload schema';
commit;
