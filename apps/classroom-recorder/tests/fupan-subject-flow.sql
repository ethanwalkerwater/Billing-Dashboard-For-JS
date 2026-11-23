-- Verify the same RPC used by the protected website against private synthetic courses.
begin;
insert into classroom_lessons("_id","teacherOpenId","teacherName",course,"startAt","endAt",stage,"createdAt","updatedAt",transcript)
values ('recSubjectFixture','fixture-subject','虚构老师','虚构课',1800000000000,1800000600000,'done',0,0,'虚构证据');
update classroom_content_reviews set version=2,status='done',findings='[
 {"id":"11111111111111111111","category":"知识讲解与纠错","priority":"重要","title":"学科一","evidence":[]},
 {"id":"22222222222222222222","category":"知识讲解与纠错","priority":"一般","title":"学科二","evidence":[]},
 {"id":"33333333333333333333","category":"录音与转写","priority":"重要","title":"无法复核证据","evidence":[]}
]' where lesson_id='recSubjectFixture';
do $$
declare item record; reply jsonb; digest text;
begin
  select source_hash into strict digest from fupan_sources where lesson_id='recSubjectFixture';
  for item in select * from fupan_issues where "lessonId"='recSubjectFixture' order by "findingId" loop
    reply:=fupan_decide(item."lessonId",digest,item.version,item."findingId",'confirm','open','直接确认','','test-supervisor','主管');
    if reply->>'error' is distinct from 'invalid' then raise exception '不允许直接计入老师确认数'; end if;
    reply:=fupan_decide(item."lessonId",digest,item.version,item."findingId",'refer','open','复核前已转办','负责人','test-supervisor','主管');
    if reply->>'state' is distinct from 'follow' then raise exception '转核失败'; end if;
    if item.category='录音与转写' then
      reply:=fupan_decide(item."lessonId",digest,item.version,item."findingId",'resolve_confirm','follow','设备已修复','','test-supervisor','主管');
      if reply->>'error' is distinct from 'invalid' then raise exception '技术项不能通过学科结案成为教师问题'; end if;
      reply:=fupan_decide(item."lessonId",digest,item.version,item."findingId",'close','follow','已修复重传','','test-supervisor','主管');
      if reply->>'result' is distinct from 'refer' then raise exception '技术转办仍应正常关闭'; end if;
    else
      reply:=fupan_decide(item."lessonId",digest,item.version,item."findingId",'close','follow','未填核对结论','','test-supervisor','主管');
      if reply->>'error' is distinct from 'invalid' then raise exception '学科核对必须明确结果'; end if;
    end if;
  end loop;
  if (select count(*) from fupan_issues where "lessonId"='recSubjectFixture' and state='follow')<>2 then raise exception '学科样本未进入跟进'; end if;
  reply:=fupan_decide('recSubjectFixture',digest,2,repeat('1',20),'resolve_confirm','follow','已核实教材原题','','test-supervisor','主管');
  if reply->>'result' is distinct from 'confirm' then raise exception '确认学科结论失败'; end if;
  if (select confirmed from fupan_catalog_lessons where id='recSubjectFixture') is distinct from 1 then raise exception '只有学科确认计数'; end if;
  -- Superseded evidence must still accept an explicit outcome against its original snapshot.
  update classroom_lessons set transcript='修订的虚构资料' where "_id"='recSubjectFixture';
  reply:=fupan_decide('recSubjectFixture',digest,2,repeat('2',20),'resolve_dismiss','follow','两个角指向不同','','test-supervisor','主管');
  if reply->>'result' is distinct from 'dismiss' then raise exception '旧版本学科事项无法排除'; end if;
  reply:=fupan_decide('recSubjectFixture',digest,2,repeat('2',20),'resolve_confirm','follow','重复提交','','test-supervisor','主管');
  if reply->>'error' is distinct from 'stale' then raise exception '已关闭记录被重复更新'; end if;
  if (select history->1->>'action' from fupan_previous_issues where "lessonId"='recSubjectFixture' and "findingId"=repeat('2',20)) is distinct from 'resolve_dismiss'
    then raise exception '历史遗漏学科核对记录'; end if;
end;
$$;
rollback;
