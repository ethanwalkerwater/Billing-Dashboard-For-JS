import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const migration = (name: string) => fileURLToPath(new URL("../migrations/" + name + ".sql", import.meta.url));
const hasPg = process.getuid?.() !== 0 && ["initdb", "pg_ctl", "psql"].every(cmd => spawnSync(cmd, ["--version"]).status === 0);
const run = promisify(execFile);

test("私有复核的版本、状态竞争、统计、听课重试及撤权", {skip: hasPg ? false : "此测试需要本机 PostgreSQL 工具及非 root 用户"}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fupan-pg-"));
  const data = join(dir, "data");
  const env = { ...process.env, PGHOST: dir, PGPORT: "5432", PGUSER: "postgres", PGDATABASE: "postgres" };
  const psql = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
  const sql = (s: string) => execFileSync("psql", [...psql, "-c", s], {env, encoding: "utf8"}).trim();
  let started = false;
  try {
    execFileSync("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"], {stdio:"ignore"});
    // A unique unix socket and no TCP listener isolate this test from every configured database.
    execFileSync("pg_ctl", ["-D", data, "-l", join(dir, "server.log"), "-o", "-p 5432 -c listen_addresses='' -k " + dir, "-w", "start"]);
    started = true;
    sql("create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean)");
    const apply = (name: string) => execFileSync("psql", [...psql, "-f", migration(name)], {env,stdio:"pipe"});
    apply("202610160001_classroom");
    apply("202610160003_classroom_admin");
    apply("202610170001_classroom_adhoc");
    apply("202610220001_classroom_audio_sec");
    apply("202610270001_classroom_archive");
    apply("202610300001_workbench");
    apply("202611200001_classroom_reviews");
    apply("202611200002_classroom_review_revision");
    sql(`insert into classroom_lessons("_id","teacherOpenId","teacherName",course,"startAt","endAt",stage,"createdAt","updatedAt",transcript)
      values ('recTest','teacher','测试老师','虚构课程',1800000000000,1800000050000,'done',0,0,'虚构转写一')`);
    const findings = ["一般","紧急","重要"].map((priority, n) => ({id:"a".repeat(19)+n, category:"课堂惩戒", priority, title:"虚构事项", evidence:[]}));
    sql("update classroom_content_reviews set status='done',findings='" + JSON.stringify(findings) + "'");
    apply("202611200003_fupan_workflow");
    apply("202611200004_fupan_catalog");
    apply("202611200005_fupan_rules");
    sql("grant select,insert,update on classroom_lessons to service_role; insert into fupan_supervisors(open_id,name) values ('test-supervisor','测试主管')");
    const asService = (s: string) => sql("set role service_role; " + s);
    const digest = sql("select source_hash from fupan_sources where lesson_id='recTest'");
    const inbox = () => JSON.parse(asService("select fupan_inbox('open',1)"));
    assert.deepEqual(inbox().items.map((i:{priority:string}) => i.priority), ["紧急","重要","一般"]);
    assert.deepEqual(inbox().counts, {open:3,follow:0,closed:0});
    for (const role of ["anon", "authenticated"]) {
      for (const object of ["fupan_supervisors","fupan_sources","fupan_decisions","fupan_notes","fupan_current_reviews","fupan_ai_issues","fupan_previous_issues","fupan_issues","fupan_lesson_notes"])
        assert.equal(sql("select has_table_privilege('" + role + "','" + object + "','SELECT')"), "f");
      for (const f of ["fupan_inbox(text,integer)","fupan_decide(text,text,integer,text,text,text,text,text,text,text)","fupan_add_note(text,text,text,uuid,text[],text,boolean)"])
        assert.equal(sql("select has_function_privilege('" + role + "','" + f + "','EXECUTE')"), "f");
    }
    const command = (id: number, action: string, expected: string, note: string, owner = "") =>
      `select fupan_decide('recTest','${digest}',1,'${findings[id].id}','${action}','${expected}','${note}','${owner}','test-supervisor','测试主管')`;
    const pending = [0,1].map(() => run("psql", [...psql, "-c", "set role service_role; " + command(0,"confirm","open","需约谈","测试负责人")], {env, encoding:"utf8"}));
    const responses = (await Promise.all(pending)).map(r => JSON.parse(r.stdout));
    assert.equal(responses.filter(r => r.state === "follow").length, 1);
    assert.equal(responses.filter(r => r.error === "stale").length, 1);
    assert.equal(JSON.parse(asService(command(0,"close","follow","已跟进"))).result, "confirm");
    assert.equal(JSON.parse(asService(command(1,"refer","open","需核对","主管"))).state, "follow");
    assert.equal(JSON.parse(asService(command(2,"dismiss","open","教学引用"))).state, "closed");
    assert.equal(asService("select count(*) from fupan_issues where result='confirm'"), "1");
    assert.equal(asService("select jsonb_array_length(history) from fupan_issues where result='confirm'"), "2");
    assert.deepEqual(inbox().counts, {open:0,follow:1,closed:2});
    apply("202611200006_fupan_history");
    execFileSync("psql",[...psql,"-f",fileURLToPath(new URL("./fupan-history.sql",import.meta.url))],{env,stdio:"pipe"});
    const addNote = (body: string) => `select fupan_add_note('recTest','test-supervisor','测试主管','00000000-0000-4000-8000-000000000001',array['建议'],'${body}',false)`;
    assert.deepEqual(JSON.parse(asService(addNote("虚构记录"))), {ok:true});
    assert.deepEqual(JSON.parse(asService(addNote("虚构记录"))), {ok:true});
    assert.deepEqual(JSON.parse(asService(addNote("冲突记录"))), {error:"stale"});
    assert.equal(asService("select count(*) from fupan_lesson_notes"), "1");
    asService("update classroom_lessons set transcript='虚构转写二' where \"_id\"='recTest'");
    assert.equal(asService("select count(*) from fupan_issues"), "0");
    assert.equal(asService("select count(*) from fupan_decisions"), "3");
    assert.equal(asService("select count(*) from fupan_previous_issues"), "3");
    assert.deepEqual(inbox().counts, {open:0,follow:1,closed:2});
    const previous = JSON.parse(asService("select fupan_inbox('follow',1)")).items[0];
    assert.equal(previous.historical,true);
    assert.equal(previous.title,"虚构事项");
    assert.equal(asService("select count(*) from fupan_issues where result='confirm'"),"0");
    assert.equal(JSON.parse(asService(command(1,"close","follow","旧转写跟进完成"))).state,"closed");
    assert.deepEqual(JSON.parse(asService(command(1,"close","follow","重复关闭"))),{error:"stale"});
    assert.deepEqual(JSON.parse(asService(command(1,"confirm","open","基于旧转写再次确认"))),{error:"stale"});
    asService("update classroom_lessons set kind='meeting' where \"_id\"='recTest'");
    assert.equal(asService("select count(*) from fupan_lesson_notes"), "0");
    assert.equal(asService("select count(*) from fupan_previous_issues"),"0");
    assert.deepEqual(inbox().counts,{open:0,follow:0,closed:0});
    assert.deepEqual(JSON.parse(asService(addNote("虚构记录"))), {error:"missing"});
    sql("delete from fupan_supervisors");
    assert.deepEqual(JSON.parse(asService(command(1,"close","follow","已撤权"))), {error:"forbidden"});
    assert.deepEqual(JSON.parse(asService(addNote("虚构记录"))), {error:"forbidden"});
  } finally {
    if (started) execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, {recursive:true, force:true});
  }
});

test("接口只接受有效状态和输入，处理人来自已鉴权身份", async (t) => {
  const {workflow} = await import("../functions/classroom-api/review/workflow");
  const actor = {openId:"ou_synthetic_test",name:"虚构主管"};
  const body = {lessonId:"recTest",sourceHash:"f".repeat(64),version:1,findingId:"1".repeat(20),
    action:"dismiss",expectedState:"open",note:"教材引用",actor:{openId:"forged"},p_actor:"forged"};
  const submit = (b: Record<string,unknown>) => workflow("POST","/decision",{},b,actor);
  const bad = {status:400};
  await assert.rejects(submit({...body,note:" "}),bad);
  await assert.rejects(submit({...body,action:"refer",owner:""}),bad);
  await assert.rejects(submit({...body,action:"confirm",expectedState:"follow"}),bad);
  await assert.rejects(submit({...body,version:0}),bad);
  await assert.rejects(workflow("GET","/inbox",{page:"1e8"},null,actor),bad);
  await assert.rejects(workflow("GET","/issues",{lessonId:"x&limit=1"},null,actor),bad);
  const originalId = process.env.CLOUDBASE_ENV_ID, originalKey = process.env.CLOUDBASE_API_KEY;
  process.env.CLOUDBASE_ENV_ID="local-fixture"; process.env.CLOUDBASE_API_KEY="test-only";
  let payload: Record<string,unknown> = {};
  let reply: Record<string,unknown> = {ok:true};
  const mocked = t.mock.method(globalThis,"fetch",async (url: string, options: RequestInit) => {
    assert.match(url, /\/rpc\/fupan_decide$/);
    payload = JSON.parse(String(options.body));
    return new Response(JSON.stringify(reply), {status:200});
  });
  try {
    await submit(body);
    assert.equal(payload.p_actor,actor.openId);
    assert.equal(payload.p_by,actor.name);
    assert.equal(Object.hasOwn(payload,"actor"),false);
    reply={error:"stale"};
    await assert.rejects(submit(body),{status:409});
  } finally {
    mocked.mock.restore();
    if(originalId===undefined) delete process.env.CLOUDBASE_ENV_ID; else process.env.CLOUDBASE_ENV_ID=originalId;
    if(originalKey===undefined) delete process.env.CLOUDBASE_API_KEY; else process.env.CLOUDBASE_API_KEY=originalKey;
  }
});
