-- No live data. Verifies both rule sources against the same adjudication RPC as AI findings.
begin;
do $$
declare issue record; changed record; reply jsonb; item jsonb;
begin
  insert into wb_cache(key,data,"syncedAt") values('m:2026-11',
    '{"h":"synthetic","rows":[["recExampleAbsent",1794690000000,1794693600000,["fixture"],"","示例课","老师","","","",""]]}'::jsonb,1794900000000);
  select * into strict issue from fupan_rule_issues where "findingId"='rule-missing';
  reply:=fupan_decide(issue."lessonId",issue."sourceHash",1,'rule-missing','refer','open','查设备','负责人','test-supervisor','测试主管');
  if reply->>'state' is distinct from 'follow' then raise exception '日规则未进入跟进'; end if;
  -- Uploading the original missing recording removes the day from the rule source entirely.
  insert into classroom_lessons("_id","teacherOpenId","teacherName",course,"startAt","endAt",stage,"createdAt","updatedAt",archive)
    values('recExampleAbsent','teacher','老师','虚构课',1794690000000,1794693600000,'done',0,0,
      '{"segments":[{"start":0,"end":800,"kind":"非教学","title":"档案初版"}]}');
  select v into strict item from jsonb_array_elements(fupan_inbox('follow',1)->'items') v where v->>'findingId'='rule-missing';
  if item->>'historical'<>'true' or item#>>'{relatedLessons,0,lessonId}' is distinct from 'recExampleAbsent'
    or item->>'title' not like '% 1 节%' then raise exception '旧日规则缺少原始关联课程'; end if;
  reply:=fupan_decide(issue."lessonId",issue."sourceHash",1,'rule-missing','close','follow','录音已补传','','test-supervisor','测试主管');
  if reply->>'state' is distinct from 'closed' then raise exception '已消失的缺录不可关闭'; end if;
  update wb_cache set data=jsonb_set(data,'{rows}','[]'::jsonb) where key='m:2026-11';
  if not exists (select from jsonb_array_elements(fupan_inbox('closed',1)->'items') v
    where v->>'lessonId'=issue."lessonId" and v->>'note'='录音已补传') then raise exception '调课后日规则关闭记录丢失'; end if;

  select * into strict issue from fupan_rule_issues where "lessonId"='recExampleAbsent' and "findingId"='rule-offtopic';
  reply:=fupan_decide(issue."lessonId",issue."sourceHash",1,issue."findingId",'confirm','open','请跟进','负责人','test-supervisor','测试主管');
  if reply->>'state' is distinct from 'follow' then raise exception '档案规则未进入跟进'; end if;
  update classroom_lessons set archive='{"segments":[{"start":20,"end":920,"kind":"非教学","title":"档案修订"}]}' where "_id"=issue."lessonId";
  select * into strict changed from fupan_rule_issues where "lessonId"=issue."lessonId" and "findingId"=issue."findingId";
  if changed.state<>'open' or changed."sourceHash"=issue."sourceHash" then raise exception '新版规则继承旧判断'; end if;
  select to_jsonb(h) into strict item from fupan_previous_issues h where h."lessonId"=issue."lessonId" and h."findingId"=issue."findingId";
  if item#>>'{evidence,0,text}' is distinct from '档案初版' then raise exception '旧档案证据被替换'; end if;
  reply:=fupan_decide(issue."lessonId",issue."sourceHash",1,issue."findingId",'confirm','open','重复旧版','','test-supervisor','测试主管');
  if reply->>'error' is distinct from 'stale' then raise exception '旧档案仍能再次确认'; end if;
  update classroom_lessons set kind='meeting' where "_id"=issue."lessonId";
  if exists(select from fupan_previous_issues where "lessonId"=issue."lessonId")
    or exists(select from jsonb_array_elements(fupan_inbox('follow',1)->'items') v where v->>'lessonId'=issue."lessonId")
    then raise exception '已改为会议的历史跟进越权'; end if;
  reply:=fupan_decide(issue."lessonId",issue."sourceHash",1,issue."findingId",'close','follow','会议越权关闭','','test-supervisor','测试主管');
  if reply->>'error' is distinct from 'stale' then raise exception '会议仍可提交关闭'; end if;
  update classroom_lessons set kind='lesson',"startAt"=1000 where "_id"=issue."lessonId";
  if exists(select from fupan_previous_issues where "lessonId"=issue."lessonId") then raise exception '试点前历史可见'; end if;
  update classroom_lessons set "startAt"=1794690000000 where "_id"=issue."lessonId";
  reply:=fupan_decide(issue."lessonId",issue."sourceHash",1,issue."findingId",'close','follow','跟进完毕','','test-supervisor','测试主管');
  if reply->>'state' is distinct from 'closed' then raise exception '旧档案不可关闭'; end if;
  if (select confirmed from fupan_catalog_lessons where id=issue."lessonId")<>0 then raise exception '旧结论计入当前课程'; end if;
  reply:=fupan_decide(changed."lessonId",changed."sourceHash",1,changed."findingId",'confirm','open','新版判断','','test-supervisor','测试主管');
  if reply->>'state' is distinct from 'closed' then raise exception '新版判断不可正常保存'; end if;
  if (select confirmed from fupan_catalog_lessons where id=issue."lessonId")<>1 then raise exception '跨版重复统计'; end if;
  update classroom_lessons set kind='meeting' where "_id"=issue."lessonId";
  if exists(select from fupan_previous_issues where "lessonId"=issue."lessonId") then raise exception '已改为会议的历史越权'; end if;
end;
$$;
rollback;
