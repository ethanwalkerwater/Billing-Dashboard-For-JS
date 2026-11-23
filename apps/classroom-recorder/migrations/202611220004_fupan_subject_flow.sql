begin;
set local lock_timeout='5s';

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

  if p_action in ('close','resolve_confirm','resolve_dismiss') then
    if p_expected is distinct from 'follow' or coalesce(btrim(p_note),'')='' then return '{"error":"invalid"}'; end if;
    -- Use the snapshot associated with the referral even if a later transcript has replaced it.
    select d.result,d.snapshot into next_result,saved from public.fupan_scoped_decisions d
    where (d.lesson_id,d.source_hash,d.version,d.finding_id)=(p_lesson,p_hash,p_version,p_finding) and d.state='follow';
    if not found then return '{"error":"stale"}'; end if;
    if next_result='refer' and saved->>'category'='知识讲解与纠错' then
      if p_action='close' then return '{"error":"invalid"}'; end if;
      next_result:=case p_action when 'resolve_confirm' then 'confirm' else 'dismiss' end;
    elsif p_action<>'close' then
      return '{"error":"invalid"}';
    end if;
    update public.fupan_decisions set state='closed',result=next_result,note=p_note,
      history=history || jsonb_build_array(entry || jsonb_build_object('owner',owner))
    where (lesson_id,source_hash,version,finding_id)=(p_lesson,p_hash,p_version,p_finding) and state='follow';
    if not found then return '{"error":"stale"}'; end if;
    return jsonb_build_object('ok',true,'state','closed','result',next_result);
  end if;

  if p_expected is distinct from 'open' or p_action is null or p_action not in ('confirm','refer','dismiss') or
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
  if p_action='confirm' and saved->>'category' in ('知识讲解与纠错','录音缺失','录音与转写') then
    return '{"error":"invalid"}';
  end if;
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
