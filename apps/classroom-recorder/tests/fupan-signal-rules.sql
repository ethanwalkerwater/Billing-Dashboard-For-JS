-- Synthetic data only; the runner creates a private local PostgreSQL cluster.
begin;
do $$
declare
  item jsonb; result jsonb; digest text; row_count int;
  a bigint:=1794358800000;
begin
  if exists(select from fupan_timing_candidates(
    '[{"start":0,"end":700,"kind":"课堂交流","title":"学习规划与选课"},
      {"start":700,"end":1500,"kind":"非教学","title":"老师安排课间休息"},
      {"start":1500,"end":2300,"kind":"课间休息","title":"休息"}]', 'adhoc',null,0))
  then raise exception '学习安排与约定休息被记为时间占用'; end if;

  insert into classroom_lessons("_id","teacherOpenId","teacherName",course,"startAt","endAt",stage,"createdAt","updatedAt",archive,transcript)
    values ('recSignal','signalTeacher','张例','模拟课程',a+172800000,a+172803600,'done',0,0,
    '{"segments":[{"start":0,"end":720,"kind":"非教学","title":"谈论球赛"}]}','虚构例句');
  insert into classroom_lessons("_id","teacherOpenId","teacherName",course,"startAt","endAt",stage,"createdAt","updatedAt")
    values ('recOtherNameA','ambiguousA','重名老师','模拟课程',a-3600000,a-3500000,'done',0,0),
           ('recOtherNameB','ambiguousB','重名老师','模拟课程',a-3650000,a-3501000,'done',0,0);
  select source_hash into strict digest from fupan_sources where lesson_id='recSignal';
  update classroom_content_reviews set status='done',findings=
    '[{"id":"languagetest","category":"粗俗表达","priority":"一般","check":"核对语境","evidence":[]},
      {"id":"privacytest","category":"隐私披露","priority":"一般","check":"核对语境","evidence":[]}]'
    where lesson_id='recSignal';
  if (select category from fupan_ai_issues where "findingId"='languagetest') is distinct from '课堂用语'
     or (select category from fupan_ai_issues where "findingId"='privacytest') is distinct from '旧版·隐私披露'
  then raise exception 'v1 兼容分类不正确'; end if;
  insert into classroom_content_reviews(lesson_id,source_hash,version,status,findings)
    values ('recSignal',digest,2,'done',
    '[{"id":"timeimpact","category":"课堂时间使用","priority":"重要","evidence":[{"start":710,"end":715}]}]');
  if (select count(*) from fupan_issues where "lessonId"='recSignal')<>1 or
    (select category from fupan_issues where "lessonId"='recSignal')<>'课堂时间使用'
    then raise exception '同一事件既由模型又由档案重复建单'; end if;
  update classroom_content_reviews set findings=jsonb_set(findings,'{0,evidence}','[{"start":800,"end":803}]')
    where lesson_id='recSignal' and version=2;
  if (select count(*) from fupan_issues where "lessonId"='recSignal')<>2 then raise exception '不重叠的时间事件被误合并'; end if;
  insert into fupan_supervisors(open_id,name) values('signalSupervisor','测试主管');
  select to_jsonb(i) into strict item from fupan_issues i where i."lessonId"='recSignal' and i."findingId"='rule-offtopic';
  result:=fupan_decide('recSignal',item->>'sourceHash',1,'rule-offtopic','dismiss','open','已核实为活动须知','','signalSupervisor','测试主管');
  if result->>'state' is distinct from 'closed' then raise exception '规则未能排除'; end if;
  update classroom_content_reviews set findings=jsonb_set(findings,'{0,evidence}','[{"start":711,"end":714}]')
    where lesson_id='recSignal' and version=2;
  if exists(select from fupan_issues where "lessonId"='recSignal' and state='open') or
     not exists(select from fupan_issues where "lessonId"='recSignal' and state='closed') then raise exception '已复核事件被重复派单'; end if;

  insert into wb_cache(key,data,"syncedAt") values('m:2026-11',jsonb_build_object('h','synthetic','rows',(
    select jsonb_agg(jsonb_build_array(id,starts,starts+3600000,jsonb_build_array('示例'),'','物理',teacher,'','','',0))
    from (values ('recStreakA',a,'张例'),('recStreakB',a+86400000,'张例'),
      ('recUnknownA',a,''),('recUnknownB',a+3700000,''),('recAmbA',a,'重名老师'),('recAmbB',a+3700000,'重名老师'),
      ('recAfter',a+259200000,'张例')) t(id,starts,teacher)
    )),a+500000000) on conflict(key) do update set data=excluded.data,"syncedAt"=excluded."syncedAt";
  if (select count(*) from fupan_missing_days where priority='重要')<>1 or
     (select members->0->>'lessonId' from fupan_missing_days where priority='重要') is distinct from 'recStreakA'
     or (select n from fupan_missing_days where priority='重要')<>2 then raise exception '连续缺录、空名、重名或插入录课的断点错误'; end if;
  select count(*) into row_count from fupan_missing_days m cross join jsonb_array_elements(m.members) member;
  if row_count<>7 or (select count(distinct member->>'lessonId') from fupan_missing_days m cross join jsonb_array_elements(m.members) member)<>7
    then raise exception '缺录课程重复或丢失'; end if;
  select v into strict item from jsonb_array_elements(fupan_inbox('open',1)->'items') v
    where v->>'priority'='重要' and v->>'findingId'='rule-missing';
  if jsonb_array_length(item->'relatedLessons')<>2 or item#>>'{relatedLessons,1,lessonId}' is distinct from 'recStreakB'
    then raise exception '跨日成员不可定位'; end if;
  result:=fupan_decide(item->>'lessonId',item->>'sourceHash',1,'rule-missing','refer','open','请查录音上传','教务','signalSupervisor','测试主管');
  if result->>'state' is distinct from 'follow' then raise exception '连续缺录未能转办'; end if;
  update wb_cache set data=jsonb_set(data,'{rows}',(data->'rows')-0) where key='m:2026-11';
  if exists(select from fupan_missing_days m cross join jsonb_array_elements(m.members) member where member->>'lessonId'='recStreakB')
     or not exists(select from fupan_previous_issues where "sourceHash"=item->>'sourceHash' and state='follow')
    then raise exception '课表变更后重复派发或丢失原跟进'; end if;
end;
$$;
do $$
declare
  a bigint:=floor(extract(epoch from now()-interval '1 day')*1000);
  digest text;
begin
  insert into classroom_lessons("_id","teacherOpenId","teacherName",course,"startAt","endAt",stage,
    "createdAt","updatedAt","asrTaskId","mergedFileId","audioSec","gapMinutes",finish,attempts,transcript)
  select id,'techTeacher','测试老师','模拟课程',a,a+600000,stage,0,0,123,id||'/merged.mp3',600,0,
    jsonb_build_object('startedAt',to_timestamp(a/1000.0),'endedAt',to_timestamp(a/1000.0)+interval '10 minutes',
      'audio',jsonb_build_object('bytes',2400000,'sha256',repeat('a',64))),tries,words
  from (values ('recTechDone','done',0,null),('recTechFailed','failed',3,''),('recTechRetry','failed',2,null),
    ('recTechPending','transcribing',0,null),('recTechSilent','done',0,null),('recTechDeleted','done',0,null),
    ('recTechOffset','done',0,'虚构转写')) cases(id,stage,tries,words);
  update classroom_lessons set "audioSec"=120 where "_id"='recTechSilent';
  update classroom_lessons set "audioDeletedAt"=a where "_id"='recTechDeleted';
  if (select count(*) from fupan_rule_issues where "findingId"='rule-transcript-missing' and "lessonId" like 'recTech%')<>2
    or exists(select from fupan_rule_issues where "findingId"='rule-transcript-missing' and "lessonId" like 'recTech%'
      and ("lessonId" not in ('recTechDone','recTechFailed') or priority<>'一般' or category<>'录音与转写'))
  then raise exception '未核准的原音、未到终态或已过期误报转写缺失'; end if;
  update classroom_lessons set transcript='虚构补转结果' where "_id"='recTechDone';
  if exists(select from fupan_rule_issues where "lessonId"='recTechDone' and "findingId"='rule-transcript-missing')
    then raise exception '补转成功仍在派单'; end if;
  select source_hash into strict digest from fupan_sources where lesson_id='recTechOffset';
  update classroom_content_reviews set findings='[{"id":"one","category":"课堂用语","evidence":[{"start":850},{"start":900}]}]',status='done'
    where lesson_id='recTechOffset';
  if exists(select from fupan_rule_issues where "lessonId"='recTechOffset' and "findingId"='rule-audio-offset')
    then raise exception '旧版本不应生成越界判断'; end if;
  insert into fupan_supervisors(open_id,name) values('techSupervisor','测试主管');
  perform fupan_decide('recTechOffset',digest,1,'one','dismiss','open','核对了原音','','techSupervisor','测试主管');
  insert into classroom_content_reviews(lesson_id,source_hash,version,status,findings)
    select lesson_id,source_hash,2,status,findings from classroom_content_reviews where lesson_id='recTechOffset' and version=1;
  if exists(select from fupan_ai_issues where "lessonId"='recTechOffset' and "findingId"='one') or not exists (
    select from fupan_previous_issues where "lessonId"='recTechOffset' and "findingId"='one' and version=1 and state='closed')
    then raise exception '同一文本同一发现的 v1 人工决定被 v2 重开或丢失'; end if;
  if (select count(*) from fupan_rule_issues where "lessonId"='recTechOffset' and "findingId"='rule-audio-offset' and priority='重要'
    and category='录音与转写' and "check" like '%850%' and evidence='[]'::jsonb)<>1 then raise exception '同课明显越界未合并为一条技术事项'; end if;
  update classroom_lessons set finish=jsonb_set(finish,'{endedAt}',to_jsonb(to_timestamp(a/1000.0)+interval '8 minutes'))
    where "_id"='recTechOffset';
  if exists(select from fupan_rule_issues where "lessonId"='recTechOffset' and "findingId"='rule-audio-offset')
    then raise exception '录制时钟与字节推算显著不一致时误报'; end if;
  update classroom_lessons set finish=jsonb_set(finish,'{endedAt}',to_jsonb(to_timestamp(a/1000.0)+interval '10 minutes')),"gapMinutes"=1
    where "_id"='recTechOffset';
  if exists(select from fupan_rule_issues where "lessonId"='recTechOffset' and "findingId"='rule-audio-offset')
    then raise exception '分块缺失导致时间轴偏移时误报'; end if;
  update classroom_lessons set "gapMinutes"=0 where "_id"='recTechOffset';
  update classroom_content_reviews set findings='[{"id":"one","category":"课堂用语","evidence":[{"start":715}]}]'
    where lesson_id='recTechOffset' and version=2;
  if exists(select from fupan_rule_issues where "lessonId"='recTechOffset' and "findingId"='rule-audio-offset')
    then raise exception '录音末尾容差内误报'; end if;
end;
$$;
rollback;
