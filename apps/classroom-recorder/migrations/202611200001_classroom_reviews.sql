begin;
create table public.classroom_content_reviews (
  lesson_id text not null references public.classroom_lessons("_id") on delete cascade,
  source_hash text not null,
  version integer not null default 1,
  status text not null default 'pending' check (status in ('pending','running','done','failed','superseded')),
  attempts integer not null default 0,
  lease uuid,
  available_at timestamptz not null default now(),
  findings jsonb,
  usage jsonb,
  error_code text,
  completed_at timestamptz,
  primary key (lesson_id, source_hash, version)
);
create index classroom_content_reviews_due on public.classroom_content_reviews (available_at)
  where status in ('pending','running','failed');
alter table public.classroom_content_reviews enable row level security;
revoke all on public.classroom_content_reviews from public, anon, authenticated;
grant select,insert,update on public.classroom_content_reviews to service_role;

create function public.queue_classroom_content_review() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if coalesce(new.kind,'lesson') in ('lesson','adhoc') and nullif(trim(new.transcript),'') is not null
     and new."startAt" >= extract(epoch from timestamptz '2026-11-11 00:00:00+08')*1000 then
    insert into public.classroom_content_reviews (lesson_id,source_hash)
    values (new."_id",encode(sha256(convert_to(new.transcript,'UTF8')),'hex')) on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.queue_classroom_content_review() from public,anon,authenticated;
create trigger classroom_content_review_enqueue after insert or update of transcript,kind on public.classroom_lessons
for each row execute function public.queue_classroom_content_review();
insert into public.classroom_content_reviews (lesson_id,source_hash)
select "_id",encode(sha256(convert_to(transcript,'UTF8')),'hex') from public.classroom_lessons
where coalesce(kind,'lesson') in ('lesson','adhoc') and nullif(trim(transcript),'') is not null
  and "startAt" between extract(epoch from timestamptz '2026-11-11 00:00:00+08')*1000 and extract(epoch from now())*1000
on conflict do nothing;
notify pgrst,'reload schema';
commit;
