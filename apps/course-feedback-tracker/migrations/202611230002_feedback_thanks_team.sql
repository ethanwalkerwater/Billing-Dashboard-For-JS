begin;

drop policy if exists feedback_thanks_records_detail on public.feedback_thanks_records;
drop policy if exists feedback_thanks_records_team on public.feedback_thanks_records;
create policy feedback_thanks_records_team on public.feedback_thanks_records for all to authenticated
  using (exists (select 1 from public.feedback_admins m
    where m.user_id = (select auth.uid())::text and m.active and nullif(m.feishu_open_id, '') is not null));

drop policy if exists feedback_thanks_gifts_detail on public.feedback_thanks_gifts;
drop policy if exists feedback_thanks_gifts_team on public.feedback_thanks_gifts;
create policy feedback_thanks_gifts_team on public.feedback_thanks_gifts for all to authenticated
  using (exists (select 1 from public.feedback_admins m
    where m.user_id = (select auth.uid())::text and m.active and nullif(m.feishu_open_id, '') is not null));

commit;
