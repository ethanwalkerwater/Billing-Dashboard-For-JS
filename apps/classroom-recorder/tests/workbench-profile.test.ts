import assert from "node:assert/strict";
import { test } from "node:test";
import { workbenchRoute } from "../functions/classroom-api/workbench";
import { monthOf } from "../src/server/workbench";

test("普通老师只能修改自己的学员资料和画像，同一项并发修改返回冲突", async (t) => {
  Object.assign(process.env, { CLOUDBASE_ENV_ID:"fixture", CLOUDBASE_API_KEY:"fixture", SCHEDULE_APP_TOKEN:"fixture", FEISHU_APP_ID:"fixture", FEISHU_APP_SECRET:"fixture" });
  const now = Date.now(), id = "recFixture";
  const record = {record_id:id, fields:{ 学生姓名:"样例学员", 联系方式n:"旧联系方式", "归属老师(20%)":"内部字段" }};
  const persona = { 家长沟通:{ tags:["电话"], text:"预约", src:"家长" } };
  let saved = { persona, updatedAt:1 }, writes = 0;
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input), path = url.pathname, method = init.method || "GET";
    const ok = (data: unknown) => Response.json(data);
    if (path.endsWith("/classroom_admin_sessions")) return ok([{openId:"teacher-fixture", name:"测试老师", scheduleName:"测试老师", expiresAt:now+60000}]);
    if (path.endsWith("/classroom_admins") || path.endsWith("/wb_roles")) return ok([]);
    if (path.endsWith("/wb_cache")) return method === "GET" ? ok([{key:"m:"+monthOf(now),data:{rows:[["r",now,now,[id],"","课程","测试老师","","","",0]]},syncedAt:now}]) : ok([]);
    if (path.endsWith("/internal")) return ok({code:0, tenant_access_token:"fixture"});
    if (path.endsWith("/records/"+id)) {
      if (method === "PUT") {
        const {fields} = JSON.parse(String(init.body));
        assert.deepEqual(Object.keys(fields), ["联系方式n"]);
        Object.assign(record.fields, fields); writes++;
      }
      return ok({code:0,data:{record}});
    }
    if (path.endsWith("/wb_students") && method === "GET") return ok([saved]);
    if (path.endsWith("/wb_students") && method === "PATCH") {
      assert.equal(url.searchParams.get("updatedAt"), "eq."+saved.updatedAt);
      saved = JSON.parse(String(init.body)); writes++; return ok([{_id:id}]);
    }
    throw Error("意外请求 "+method+" "+path);
  });
  const put = (sid: string, body: unknown) => workbenchRoute("PUT", "/wb/students/"+sid,
    {headers:{authorization:"Bearer fixture", "x-view-as-teacher":encodeURIComponent("其他老师")}, body:JSON.stringify(body)}, {});
  assert.equal((await put("recOther", {roster:{contact:"号码"}})).statusCode, 404);
  assert.equal((await put("recOther", {notes:{}})).statusCode, 404);
  assert.equal((await put(id, {stage:"结课"})).statusCode, 403);
  assert.equal((await put(id, {roster:{channel:"渠道"}})).statusCode, 400);
  assert.equal(writes, 0);
  const roster = await put(id, {roster:{contact:"新联系方式"}});
  assert.equal(roster.statusCode, 200);
  assert.equal(JSON.parse(roster.body).student.contact, "新联系方式");
  assert.equal(JSON.parse(roster.body).student.ownerTeacher, undefined);
  const notes = await put(id, {notes:{ 学习偏好:{before:"", text:"先画图。\n再讲原理。"} }});
  assert.equal(notes.statusCode, 200);
  assert.deepEqual(JSON.parse(notes.body).persona.家长沟通, persona.家长沟通);
  assert.equal(JSON.parse(notes.body).persona.学习偏好.text, "先画图。\n再讲原理。");
  assert.equal((await put(id, {notes:{ 学习偏好:{before:"", text:"另一条"} }})).statusCode, 409);
  assert.equal(writes, 2);
});
