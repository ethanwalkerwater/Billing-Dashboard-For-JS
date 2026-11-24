begin;
create or replace function public.queue_classroom_content_review() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare current_hash text;
begin
  if tg_op = 'UPDATE' then
    if old.kind is not distinct from new.kind and old.transcript is not distinct from new.transcript then return new; end if;
  end if;
  if coalesce(new.kind,'lesson') in ('lesson','adhoc') and nullif(trim(new.transcript),'') is not null
     and new."startAt" >= extract(epoch from timestamptz '2026-11-11 00:00:00+08')*1000 then
    current_hash := encode(sha256(convert_to(new.transcript,'UTF8')),'hex');
    insert into public.classroom_content_reviews as r (lesson_id,source_hash)
    values (new."_id",current_hash) on conflict (lesson_id,source_hash,version) do update
    set status='pending', attempts=0, lease=null, available_at=now() where r.status='superseded';
  end if;
  update public.classroom_content_reviews set status='superseded', lease=null
    where lesson_id=new."_id" and source_hash is distinct from current_hash and status in ('pending','running','failed');
  return new;
end;
$$;
commit;
