import { eq, pg } from "../index";

type Actor = { openId: string; name: string };
const invalid = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("请填写表单后提交");
  return input as Record<string, unknown>;
}

function text(value: unknown, max: number, label: string, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) return invalid(label);
  return value.trim();
}

function matched(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) return invalid(label);
  return value;
}

const lessonId = (v: unknown) => matched(v, /^[\w-]{1,128}$/, "课程编号无效");

async function write(name: string, args: Record<string, unknown>) {
  const response = await pg("POST", "rpc/" + name, "", args) as unknown as {ok?: boolean; error?: string};
  if (response.ok === true) return response;
  switch (response.error) {
    case "stale": return invalid("内容或处理状态已更新，请刷新后重试", 409);
    case "forbidden": return invalid("此账号没有课堂复盘权限", 403);
    case "missing": return invalid("没有找到这节课", 404);
    case "invalid": return invalid("此处理操作或填写内容无效");
    default: throw new Error("复盘写入返回异常");
  }
}

export async function workflow(method: string, path: string, query: Record<string, string>, raw: unknown, actor: Actor) {
  if (method === "GET" && path === "/inbox") {
    const state = matched(query.state ?? "open", /^(open|follow|closed)$/, "事项状态无效");
    const page = Number(matched(query.page ?? "1", /^[1-9]\d{0,5}$/, "页码无效"));
    return pg("POST", "rpc/fupan_inbox", "", { p_state: state, p_page: page });
  }
  if (method === "GET" && path === "/issues") {
    const queryString = "lessonId=" + eq(lessonId(query.lessonId)) + "&order=findingId.asc";
    const [items, previousItems] = await Promise.all([
      pg("GET", "fupan_issues", queryString), pg("GET", "fupan_previous_issues", queryString),
    ]);
    return { items, previousItems };
  }
  if (method === "POST" && path === "/decision") {
    const b = object(raw);
    const action = matched(b.action, /^(confirm|refer|dismiss|close|resolve_confirm|resolve_dismiss)$/, "请选择处理方式");
    const expected = matched(b.expectedState, /^(open|follow)$/, "事项状态无效");
    const completesFollow = ["close", "resolve_confirm", "resolve_dismiss"].includes(action);
    if (completesFollow !== (expected === "follow")) return invalid("此操作不适用于当前状态");
    if (!Number.isSafeInteger(b.version) || Number(b.version) < 1 || Number(b.version) > 2147483647) return invalid("分析版本无效");
    return write("fupan_decide", {
      p_lesson: lessonId(b.lessonId), p_hash: matched(b.sourceHash, /^[0-9a-f]{64}$/, "转写版本无效"),
      p_version: b.version, p_finding: matched(b.findingId, /^(?:[0-9a-f]{20}|rule-(?:missing|overtime|offtopic|management|transcript-missing|audio-offset))$/, "事项编号无效"),
      p_action: action, p_expected: expected,
      p_note: text(b.note, 4000, "请填写不超过 4000 字的处理说明", action === "dismiss" || completesFollow),
      p_owner: text(b.owner, 80, "请填写不超过 80 字的跟进负责人", action === "refer"),
      p_actor: actor.openId, p_by: actor.name,
    });
  }
  return invalid("接口不存在", 404);
}
