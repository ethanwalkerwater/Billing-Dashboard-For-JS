begin;
set local lock_timeout = '5s';

create table public.fupan_supervisors (
  open_id text primary key,
  name text not null,
  grant_id uuid not null default gen_random_uuid()
);

-- Fingerprint once when a transcript changes. Inbox reads never fetch or hash full transcripts.
create table public.fupan_sources (
  lesson_id text primary key references public.classroom_lessons("_id") on delete cascade,
  source_hash text not null
);

create function public.fupan_set_source() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' then
    if new.kind is not distinct from old.kind and new.transcript is not distinct from old.transcript then
      return new;
    end if;
  end if;
  if coalesce(new.kind,'lesson') in ('lesson','adhoc') and nullif(btrim(new.transcript),'') is not null then
    insert into public.fupan_sources as s (lesson_id,source_hash)
    values (new."_id",encode(sha256(convert_to(new.transcript,'UTF8')),'hex'))
    on conflict (lesson_id) do update set source_hash=excluded.source_hash
      where s.source_hash is distinct from excluded.source_hash;
  else
    delete from public.fupan_sources where lesson_id=new."_id";
  end if;
  return new;
end;
$$;
create trigger fupan_track_source after insert or update of transcript,kind on public.classroom_lessons
  for each row execute function public.fupan_set_source();

insert into public.fupan_sources (lesson_id,source_hash)
select l."_id",encode(sha256(convert_to(l.transcript,'UTF8')),'hex')
from public.classroom_lessons l
where exists (select 1 from public.classroom_content_reviews r where r.lesson_id=l."_id")
  and coalesce(l.kind,'lesson') in ('lesson','adhoc') and nullif(btrim(l.transcript),'') is not null;

create view public.fupan_current_reviews as
select distinct on (r.lesson_id) r.* from public.classroom_content_reviews r
join public.fupan_sources s using (lesson_id,source_hash)
join public.classroom_lessons l on l."_id"=r.lesson_id
where l."startAt" >= extract(epoch from timestamptz '2026-11-11 00:00:00+08')*1000
order by r.lesson_id,r.version desc;

create table public.fupan_decisions (
  lesson_id text not null,
  source_hash text not null,
  version integer not null,
  finding_id text not null,
  state text not null check (state in ('follow','closed')),
  result text not null check (result in ('confirm','dismiss','refer')),
  owner text not null,
  note text not null,
  history jsonb not null,
  primary key (lesson_id,source_hash,version,finding_id),
  ai_lesson text generated always as (case when finding_id like 'rule-%' then null else lesson_id end) stored,
  foreign key (ai_lesson,source_hash,version)
    references public.classroom_content_reviews (lesson_id,source_hash,version) on delete cascade
);

create view public.fupan_ai_issues as
select r.lesson_id as "lessonId", r.source_hash as "sourceHash", r.version, f->>'id' as "findingId",
  l."teacherOpenId",l."teacherName",l.course,l."startAt", f->>'category' as category,
  f->>'priority' as priority,f->>'title' as title,f->>'check' as "check",f->'evidence' as evidence,
  coalesce(d.state,'open') as state, d.result,coalesce(d.owner,'') as owner,coalesce(d.note,'') as note,
  coalesce(d.history,'[]'::jsonb) as history
from public.fupan_current_reviews r
join public.classroom_lessons l on l."_id"=r.lesson_id
cross join lateral jsonb_array_elements(r.findings) f
left join public.fupan_decisions d on (d.lesson_id,d.source_hash,d.version,d.finding_id)
  = (r.lesson_id,r.source_hash,r.version,f->>'id')
where r.status='done';

-- Rule findings use this same public column contract in the following migration.
create view public.fupan_issues as select * from public.fupan_ai_issues;

create view public.fupan_previous_issues as
select d.lesson_id as "lessonId",d.source_hash as "sourceHash",d.version,d.finding_id as "findingId",
  l."teacherOpenId",l."teacherName",l.course,l."startAt",f->>'category' as category,
  f->>'priority' as priority,f->>'title' as title,f->>'check' as "check",f->'evidence' as evidence,
  d.state,d.result,d.owner,d.note,d.history
from public.fupan_decisions d
join public.classroom_content_reviews r using (lesson_id,source_hash,version)
join public.classroom_lessons l on l."_id"=d.lesson_id
cross join lateral jsonb_array_elements(r.findings) f
where coalesce(l.kind,'lesson') in ('lesson','adhoc')
  and l."startAt" >= extract(epoch from timestamptz '2026-11-11 00:00:00+08')*1000
  and f->>'id'=d.finding_id and not exists (select 1 from public.fupan_current_reviews c
    where (c.lesson_id,c.source_hash,c.version)=(d.lesson_id,d.source_hash,d.version));

create function public.fupan_inbox(p_state text,p_page integer) returns jsonb
language sql stable set search_path = pg_catalog, public as $$
  with counts as (
    select state,count(*) as n from public.fupan_issues group by state
  ), page as (
    select i.*,case priority when '紧急' then 3 when '重要' then 2 else 1 end as rank
    from public.fupan_issues i where state=p_state
    order by rank desc,"startAt" desc,"lessonId","findingId" limit 25 offset ((p_page-1)*25)
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'rank'
    order by rank desc,"startAt" desc,"lessonId","findingId") from page p),'[]'::jsonb),
    'counts',jsonb_build_object('open',0,'follow',0,'closed',0) ||
      coalesce((select jsonb_object_agg(state,n) from counts),'{}'::jsonb),
    'total',coalesce((select n from counts where state=p_state),0),'page',p_page,'pageSize',25)
$$;

create function public.fupan_decide(
  p_lesson text,p_hash text,p_version integer,p_finding text,p_action text,p_expected text,
  p_note text,p_owner text,p_actor text,p_by text
) returns jsonb language plpgsql set search_path = pg_catalog, public as $$
declare item public.fupan_issues%rowtype; next_state text; next_result text; next_owner text; entry jsonb;
begin
  perform 1 from public.fupan_supervisors where open_id=p_actor for share;
  if not found then return '{"error":"forbidden"}'; end if;
  -- All decisions for one lesson serialize with each other and with edits to its transcript.
  perform pg_advisory_xact_lock(hashtextextended(p_lesson,0));
  perform 1 from public.classroom_lessons where "_id"=p_lesson for update;
  select * into item from public.fupan_issues where "lessonId"=p_lesson
    and "sourceHash"=p_hash and version=p_version and "findingId"=p_finding;
  if not found or item.state<>p_expected then return '{"error":"stale"}'; end if;

  if p_action in ('confirm','refer','dismiss') and item.state='open' then
    if (p_finding='rule-missing' and p_action='confirm') or
       (p_action='refer' and btrim(p_owner)='') or (p_action='dismiss' and btrim(p_note)='') then
      return '{"error":"invalid"}';
    end if;
    next_result := p_action;
    next_owner := case when p_action='dismiss' then '' else p_owner end;
    next_state := case when p_action='refer' or (p_action='confirm' and next_owner<>'') then 'follow' else 'closed' end;
  elsif p_action='close' and item.state='follow' and btrim(p_note)<>'' then
    next_result := item.result; next_owner := item.owner; next_state := 'closed';
  else
    return '{"error":"invalid"}';
  end if;

  entry := jsonb_build_object('action',p_action,'at',clock_timestamp(),'by',p_by,'actorId',p_actor,'owner',next_owner,'note',p_note);
  insert into public.fupan_decisions as d (lesson_id,source_hash,version,finding_id,state,result,owner,note,history)
    values (p_lesson,p_hash,p_version,p_finding,next_state,next_result,next_owner,p_note,jsonb_build_array(entry))
    on conflict (lesson_id,source_hash,version,finding_id) do update
      set state=excluded.state,result=excluded.result,owner=excluded.owner,note=excluded.note,
          history=d.history || excluded.history;
  return jsonb_build_object('ok',true,'state',next_state,'result',next_result);
end;
$$;

create table public.fupan_notes (
  lesson_id text not null references public.classroom_lessons("_id") on delete cascade,
  author_id text not null,
  request_id uuid not null,
  author_name text not null,
  tags text[] not null,
  text text not null check (length(text) between 1 and 4000),
  count_as_listened boolean not null,
  created_at timestamptz not null default now(),
  primary key(author_id,request_id)
);
create index fupan_notes_lesson_idx on public.fupan_notes(lesson_id,created_at desc);

create view public.fupan_lesson_notes as
select n.lesson_id as "lessonId",n.request_id as "requestId",n.author_name as "by",n.created_at as at,
  n.tags,n.text,n.count_as_listened as "countAsListened"
from public.fupan_notes n join public.classroom_lessons l on l."_id"=n.lesson_id
where coalesce(l.kind,'lesson') in ('lesson','adhoc')
  and l."startAt" >= extract(epoch from timestamptz '2026-11-11 00:00:00+08')*1000;

create function public.fupan_add_note(p_lesson text,p_actor text,p_by text,p_request uuid,
  p_tags text[],p_text text,p_listened boolean) returns jsonb
language plpgsql set search_path = pg_catalog, public as $$
declare saved public.fupan_notes%rowtype;
begin
  perform 1 from public.fupan_supervisors where open_id=p_actor for share;
  if not found then return '{"error":"forbidden"}'; end if;
  perform 1 from public.classroom_lessons where "_id"=p_lesson and coalesce(kind,'lesson') in ('lesson','adhoc')
    and "startAt" >= extract(epoch from timestamptz '2026-11-11 00:00:00+08')*1000 for share;
  if not found then return '{"error":"missing"}'; end if;
  insert into public.fupan_notes (lesson_id,author_id,author_name,request_id,tags,text,count_as_listened)
    values (p_lesson,p_actor,p_by,p_request,p_tags,p_text,p_listened) on conflict do nothing;
  if not found then
    select * into strict saved from public.fupan_notes where author_id=p_actor and request_id=p_request;
    if (saved.lesson_id,saved.tags,saved.text,saved.count_as_listened) is distinct from
       (p_lesson,p_tags,p_text,p_listened) then return '{"error":"stale"}'; end if;
  end if;
  return '{"ok":true}';
end;
$$;

alter table public.fupan_supervisors enable row level security;
alter table public.fupan_sources enable row level security;
alter table public.fupan_decisions enable row level security;
alter table public.fupan_notes enable row level security;
revoke all on public.fupan_supervisors,public.fupan_sources,public.fupan_decisions,public.fupan_notes,
  public.fupan_current_reviews,public.fupan_ai_issues,public.fupan_issues,public.fupan_previous_issues,public.fupan_lesson_notes from public,anon,authenticated;
grant select on public.fupan_supervisors,public.fupan_current_reviews,public.fupan_ai_issues,public.fupan_issues,public.fupan_previous_issues,public.fupan_lesson_notes to service_role;
grant select,insert,update,delete on public.fupan_sources to service_role;
grant select,insert,update on public.fupan_decisions to service_role;
grant select,insert on public.fupan_notes to service_role;
-- FOR SHARE inside the write RPC requires UPDATE permission in addition to SELECT.
grant update (name) on public.fupan_supervisors to service_role;
revoke all on function public.fupan_set_source(),public.fupan_inbox(text,integer),
  public.fupan_decide(text,text,integer,text,text,text,text,text,text,text),
  public.fupan_add_note(text,text,text,uuid,text[],text,boolean) from public,anon,authenticated;
grant execute on function public.fupan_inbox(text,integer),
  public.fupan_decide(text,text,integer,text,text,text,text,text,text,text),
  public.fupan_add_note(text,text,text,uuid,text[],text,boolean) to service_role;
notify pgrst,'reload schema';
commit;
