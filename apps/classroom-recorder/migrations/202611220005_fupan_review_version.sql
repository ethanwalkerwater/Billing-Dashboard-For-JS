begin;
set local lock_timeout='5s';

-- Only new or changed transcripts enter the v15 queue. Existing completed results are
-- re-analysed in a bounded batch; its validated replacement arrives as a completed row.
alter table public.classroom_content_reviews alter column version set default 2;

-- A pending replacement must not hide a previously completed review of the same text.
create or replace view public.fupan_current_reviews as
select distinct on (r.lesson_id) r.* from public.classroom_content_reviews r
join public.fupan_sources s using (lesson_id,source_hash)
join public.classroom_lessons l on l."_id"=r.lesson_id
where l."startAt">=1794326400000 and coalesce(l.kind,'lesson') in ('lesson','adhoc')
order by r.lesson_id,(r.status='done') desc,r.version desc;

-- Transfer unfinished jobs atomically. A worker holding an older lease cannot
-- subsequently overwrite either the new job or the previously completed record.
with unfinished as (
  update public.classroom_content_reviews r set status='superseded', lease=null
  from public.fupan_sources s
  where r.lesson_id=s.lesson_id and r.source_hash=s.source_hash and r.version=1
    and r.status in ('pending','running','failed')
  returning r.lesson_id,r.source_hash
)
insert into public.classroom_content_reviews(lesson_id,source_hash,version)
select lesson_id,source_hash,2 from unfinished on conflict do nothing;

notify pgrst,'reload schema';
commit;
