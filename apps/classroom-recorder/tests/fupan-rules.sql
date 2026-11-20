-- Synthetic archive and timetable; can run against the isolated PG test schema after all migrations.
begin;
do $$
declare x record; status jsonb;
begin
  if exists(select from fupan_timing_candidates('[{"start":0,"end":900,"kind":"课堂交流","title":"暂停 15 分钟"}]', 'adhoc', null, 0)) then
    raise exception '录制暂停不能算非教学'; end if;
  if exists(select from fupan_timing_candidates('[{"start":0,"end":900,"kind":"讲解"}]', 'lesson', 'bad-dateZ', 0)) then
    raise exception '没有可靠录音时钟不可判拖堂'; end if;
  if (select count(*) from fupan_timing_candidates(
    '[{"start":0,"end":610,"kind":"非教学","title":"示例"},{"start":610,"end":1000,"kind":"课堂管理","title":"示例管理"}]',
    'lesson','2026-11-15T01:00:00Z',(extract(epoch from timestamptz '2026-11-15T01:10:00Z')*1000)::bigint)) <> 3 then
    raise exception '规则阈值或参考时钟错误'; end if;

  insert into wb_cache(key,data,"syncedAt") values ('m:2026-11',jsonb_build_object('h','synthetic','rows',
    '[
     ["recMissingA",1794690000000,1794693600000,["fixture"],"","数学","老师","","","",""],
     ["recCancelled",1794690000000,1794693600000,["fixture"],"","数学","老师","","","取消",""],
     ["recMeeting",1794690000000,1794693600000,["fixture"],"","内部会议","老师","","","",""]
    ]'::jsonb),1794900000000) on conflict (key) do update set data=excluded.data,"syncedAt"=excluded."syncedAt";
  insert into fupan_supervisors(open_id,name) values('rule-fixture','测试主管');
  select * into strict x from fupan_rule_issues where "findingId"='rule-missing';
  if x.title not like '% 1 节%' then raise exception '取消与会议不应算漏录'; end if;
  status:=fupan_decide(x."lessonId",x."sourceHash",1,'rule-missing','confirm','open','记为老师问题','','rule-fixture','测试主管');
  if status->>'error' is null then raise exception '缺录音不计为老师问题'; end if;
  status:=fupan_decide(x."lessonId",x."sourceHash",1,'rule-missing','dismiss','open','已调课','','rule-fixture','测试主管');
  if status->>'state' is distinct from 'closed' then raise exception '按天缺录音复核失败'; end if;

  if has_table_privilege('authenticated','fupan_rule_issues','select')
      or has_function_privilege('anon','fupan_timing_candidates(jsonb,text,text,bigint)','execute') then
    raise exception '私有规则数据权限不正确'; end if;
end;
$$;
rollback;
