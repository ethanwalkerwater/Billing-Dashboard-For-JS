import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { audioKey, summarizeTeachers, courseRow, catalog } from "../functions/classroom-api/review/catalog";
import type { LessonRow } from "../src/server/workbench";

test("课表与录音按课程编号去重，同名身份分开统计，缺快照回退有录音数", () => {
  const teacher = (id: string) => ({
    id,
    name: "测试老师",
    aliases: ["测试老师"],
    monthIds: ["rec" + id],
    courses: ["物理"],
    modes: { 讲授型: 1 },
    medianTalkRatio: 0.72,
    pending: 3,
    confirmed: 1,
  });
  const schedule = (id: string): LessonRow => [id, 100, 200, [], "模拟学员", "物理", "测试老师", "", "一对一", "", 0];
  const teachers = [teacher("Alpha"), teacher("Beta")];
  const result = summarizeTeachers(teachers, [], {
    rows: [schedule("recAlpha"), schedule("recNoRecording")],
    syncedAt: 123,
  });
  assert.deepEqual(result.map((t) => [t.id, t.monthly]).sort(), [
    ["Alpha", 1],
    ["Beta", 1],
    [result.find((t) => t.id.startsWith("sched-"))?.id, 1],
  ]);
  assert.match(result.find((t) => t.id.startsWith("sched-"))!.id, /^sched-[0-9a-f]{32}$/);
  assert.equal(summarizeTeachers(teachers, [], null)[0].monthly, null);
  assert.equal(summarizeTeachers(teachers, [], null)[0].recordedMonthly, 1);
});
test("只签本节试点课的有效原音，到期前缩短签名", () => {
  const start = Date.parse("2026-11-12T00:00:00+08:00");
  const lesson = { _id: "recAlpha", startAt: start, kind: "lesson" as const, mergedFileId: "recAlpha/merged.mp3" };
  assert.equal(audioKey(lesson, start + 400).expiresIn, 300);
  const end = start + 30 * 86400_000;
  assert.equal(audioKey(lesson, end - 5500).expiresIn, 5);
  assert.throws(() => audioKey(lesson, end), /原音已过期/);
  assert.throws(() => audioKey({ ...lesson, mergedFileId: "recOther/merged.mp3" }, start), /暂无/);
  assert.throws(() => audioKey({ ...lesson, kind: "meeting" }, start), /没有找到/);
  assert.throws(() => audioKey({ ...lesson, startAt: start - 10 * 86400_000 }, start), /没有找到/);
  const view = courseRow(
    {
      id: lesson._id,
      teacherId: "ou_test",
      teacherName: "测试",
      course: "虚构课",
      student: "",
      startAt: start,
      endAt: end,
      stage: "empty",
      audioSec: 80,
      audioDeleted: false,
      audioPresent: false,
      hasTranscript: true,
      reviewStatus: "done",
      pending: 0,
      confirmed: 0,
      metrics: null,
    },
    start,
  );
  assert.equal(view.analysisStatus, "分析完成");
});
const hasPostgres =
  process.getuid?.() !== 0 && ["initdb", "pg_ctl", "psql"].every((cmd) => spawnSync(cmd, ["--version"]).status === 0);
test("教学统计迁移、录音时间边界、课表和权限", { skip: hasPostgres ? false : "需要本机 PostgreSQL" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fupan-catalog-")),
    data = join(dir, "data");
  const env = { ...process.env, PGHOST: dir, PGPORT: "5432", PGUSER: "postgres", PGDATABASE: "postgres" };
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
  const sql = (s: string) => execFileSync("psql", [...args, "-c", s], { env, encoding: "utf8" }).trim();
  let started = false;
  try {
    execFileSync("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", [
      "-D",
      data,
      "-l",
      join(dir, "log"),
      "-o",
      "-p 5432 -c listen_addresses='' -k " + dir,
      "-w",
      "start",
    ]);
    started = true;
    sql(
      "create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean)",
    );
    for (const name of [
      "202610160001_classroom",
      "202610160003_classroom_admin",
      "202610170001_classroom_adhoc",
      "202610220001_classroom_audio_sec",
      "202610270001_classroom_archive",
      "202610300001_workbench",
      "202611200001_classroom_reviews",
      "202611200002_classroom_review_revision",
      "202611200003_fupan_workflow",
      "202611200004_fupan_catalog",
      "202611200005_fupan_rules",
      "202611200007_fupan_teacher_coverage",
    ]) {
      execFileSync("psql", [...args, "-f", fileURLToPath(new URL("../migrations/" + name + ".sql", import.meta.url))], {
        env,
        stdio: "pipe",
      });
    }
    const tx = "[老师 00:00-00:29] 为什么？\n[学生 00:30-01:00] 因为。";
    const metric = JSON.parse(sql("select fupan_metrics('" + tx + "',60)"));
    assert.deepEqual(metric, {
      mode: "对话型",
      rt: 0.5,
      ch: 0.5,
      talkRatio: 0.483,
      questions: 1,
      openQuestions: 1,
      longestLectureSec: 30,
    });
    assert.equal(sql("select fupan_metrics('[说话人1 00:00-00:10] 虚构',10) is null"), "t");
    sql(`insert into classroom_lessons("_id","teacherOpenId","teacherName",course,"startAt","endAt","audioSec",stage,"createdAt","updatedAt",transcript) values
      ('recTest','ou_test','测试老师','模拟课',1800000000000,1800000060000,60,'done',0,0,'${tx}')`);
    assert.equal(sql("select metrics->>'mode' from fupan_catalog_lessons"), "对话型");
    assert.equal(sql("select modes->>'对话型' from fupan_teacher_stats(1794326400000,1794326400000,1800000000001)"), "1");
    sql("update classroom_lessons set transcript='[老师 00:00-01:00] 演示' where \"_id\"='recTest'");
    assert.equal(sql("select metrics->>'mode' from fupan_catalog_lessons"), "讲授型");
    sql("update classroom_lessons set kind='meeting' where \"_id\"='recTest'");
    assert.equal(sql("select count(*) from fupan_catalog_lessons"), "0");
    sql(
      `insert into wb_cache(key,data,"syncedAt") values ('m:2027-01','{"h":"hash","rows":[["recPlan",1800000000000,1800000100000,[],"","","","", "", "",0]]}',100)`,
    );
    assert.equal(sql("select jsonb_array_length(rows) from fupan_schedule('2027-01',1799999999999,1800000000001)"), "1");
    assert.equal(sql("select \"row\"->>0 from fupan_scheduled_lesson('recPlan')"), "recPlan");
    sql(`update classroom_lessons set kind='lesson' where "_id"='recTest';
      update wb_cache set data='{"h":"hash","rows":[
        ["recTest",1800000000000,1800000060000,[],"","数学","测试老师","","","",0],
        ["recPlan",1800000000000,1800000060000,[],"","数学","测试老师","","","",0],
        ["recCancel",1800000000000,1800000060000,[],"","数学","测试老师","","","是",0]
      ]}' where key='m:2027-01'`);
    const coverage = (start: number) => JSON.parse(sql(`select to_jsonb(c) from fupan_teacher_coverage('ou_test',array['测试老师'],${start},1800000001000) c`));
    assert.deepEqual(coverage(1800000000000), {recorded:1,total:2});
    assert.deepEqual(coverage(1797000000000), {recorded:1,total:null});
    for (const role of ["authenticated", "anon"]) {
      assert.equal(sql("select has_function_privilege('" + role + "','fupan_teacher_coverage(text,text[],bigint,bigint)','execute')"), "f");
      assert.equal(sql("select has_table_privilege('" + role + "','fupan_catalog_lessons','select')"), "f");
      assert.equal(
        sql("select has_function_privilege('" + role + "','fupan_teacher_stats(bigint,bigint,bigint)','execute')"),
        "f",
      );
    }
    execFileSync("psql", [...args, "-f", fileURLToPath(new URL("./fupan-rules.sql", import.meta.url))], {
      env,
      stdio: "pipe",
    });
    for (const file of ["../migrations/202611200006_fupan_history.sql", "../migrations/202611220003_fupan_signal_rules.sql", "./fupan-signal-rules.sql"]) {
      execFileSync("psql", [...args, "-f", fileURLToPath(new URL(file, import.meta.url))], {env, stdio:"pipe"});
    }
  } finally {
    if (started) execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("姓名搜索不写入 URL，查询参数异常时不发起外部请求", async () => {
  const actor = { openId: "fake", name: "测试" },
    deps = { signedUrl: async () => "fake" };
  await assert.rejects(catalog("GET", "/teacher-options", { q: "测试" }, {}, actor, deps), /请使用表单/);
  await assert.rejects(catalog("GET", "/teacher", { id: "schedule:测试" }, {}, actor, deps), /请使用表单/);
  await assert.rejects(catalog("POST", "/teacher-options/search", {}, { q: [] }, actor, deps), /查询条件无效/);
});
