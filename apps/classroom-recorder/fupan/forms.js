import {
  esc,
  timestamp,
  badge,
  relatedCourses,
  historicalEvidence,
  historicalStatus,
} from "./ui.js";

const dialog = document.querySelector("#form-dialog");
let serial = 0;
export function closeForm() {
  serial++;
  if (dialog.open) dialog.close();
  dialog.replaceChildren();
}
dialog.addEventListener("close", () => {
  if (!dialog.open) dialog.replaceChildren();
});

function openForm(title, summary, fields, save, label = "保存") {
  closeForm();
  const seq = ++serial;
  dialog.innerHTML = `<div class="row"><h2 id="dialog-title" class="grow">${esc(title)}</h2><button type="button" class="btn sm ghost" data-cancel>关闭</button></div>${summary}
  <form><div class="fields">${fields}</div><p class="form-error" role="alert"></p><div class="actions"><button type="button" class="btn outline" data-cancel>取消</button><button class="btn" type="submit">${esc(label)}</button></div></form>`;
  dialog
    .querySelectorAll("[data-cancel]")
    .forEach((b) => (b.onclick = closeForm));
  dialog.showModal();
  const form = dialog.querySelector("form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const submit = form.querySelector("[type=submit]"),
      error = form.querySelector("[role=alert]");
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = "";
    try {
      await save(new FormData(form));
      if (seq === serial) closeForm();
    } catch (err) {
      if (seq === serial)
        error.textContent = err.message || "保存失败，请重试。";
    } finally {
      submit.disabled = false;
    }
  };
  return form;
}

export function reviewForm(item, api, refresh, play) {
  const follow = item.state === "follow";
  const subject = item.category === "知识讲解与纠错";
  const equipment = item.findingId === "rule-missing" || ["录音与转写", "录音缺失"].includes(item.category);
  const options = follow
    ? (subject && item.result === "refer"
        ? [["resolve_confirm", "学科核对后确认"], ["resolve_dismiss", "学科核对后排除"]]
        : [])
    : subject
    ? [["refer", "交学科老师核对"], ["dismiss", "排除"]]
    : equipment
    ? [["refer", "转办设备或转写检查"], ["dismiss", "排除"]]
    : [
        ["record", "确认，记录在案"],
        ["talk", "确认，安排跟进"],
        ["dismiss", "排除"],
        ["refer", "转办，暂不确认"],
      ];
  const summary = `<p>${item.historical ? badge("历史版本") + " " : ""}${badge(item.priority)} ${esc(item.category)} · ${esc(item.title)}</p>
    ${item.check ? '<p class="sm muted preserve">' + esc(item.check) + "</p>" : ""}
    ${relatedCourses(item)}
    ${item.historical ? historicalEvidence(item) + '<p class="sm muted">' + historicalStatus(item) + "</p>" : (item.evidence || []).map((e, i) => '<div class="qline"><button class="ev" data-evidence="' + i + '">' + timestamp(e.start) + "</button><small>" + esc(e.speaker) + "</small><span>" + esc(e.text) + "</span></div>").join("")}`;
  const choices = !options.length
    ? ""
    : "<fieldset><legend>复核结果</legend>" +
      options
        .map(
          ([v, n]) =>
            '<label class="choice"><input name="action" type="radio" required value="' +
            v +
            '">' +
            n +
            "</label>",
        )
        .join("") +
      "</fieldset>";
  const fields =
    choices +
    '<label class="field" hidden data-owner>跟进负责人<input class="input" name="owner" maxlength="80"></label><label class="field">' +
    (follow ? "跟进结果" : "复核备注") +
    '<textarea class="input" name="note" maxlength="4000" ' +
    (follow ? "required" : "") +
    "></textarea></label>";
  const form = openForm(
    follow ? "记录跟进结果" : "复核",
    summary,
    fields,
    async (data) => {
      const choice = options.length ? data.get("action") : "close";
      const action = ["record", "talk"].includes(choice) ? "confirm" : choice;
      await api("/decision", null, {
        lessonId: item.lessonId,
        sourceHash: item.sourceHash,
        version: item.version,
        findingId: item.findingId,
        expectedState: item.state,
        action,
        owner: ["talk", "refer"].includes(choice)
          ? String(data.get("owner")).trim()
          : "",
        note: String(data.get("note")).trim(),
      });
      refresh("处理结果已保存。");
    },
    follow ? "关闭事项" : "提交复核",
  );
  form.addEventListener("change", () => {
    const choice = form.elements.action?.value;
    const needsOwner = ["talk", "refer"].includes(choice);
    form.querySelector("[data-owner]").hidden = !needsOwner;
    form.elements.owner.required = needsOwner;
    form.elements.note.required = follow || choice === "dismiss";
  });
  dialog
    .querySelectorAll("[data-evidence]")
    .forEach(
      (btn) =>
        (btn.onclick = () =>
          play(
            item.lessonId,
            item.evidence[Number(btn.dataset.evidence)].start,
            true,
          )),
    );
}

export function teacherForm(api, refresh) {
  let options = [],
    search = 0;
  const form = openForm(
    "添加老师",
    "",
    `<label class="field">老师姓名<div class="row"><input name="q" class="input" maxlength="40" placeholder="搜索已有老师档案" autofocus><button class="btn sm outline" type="button" data-find>查找</button></div></label>
    <label class="field">匹配档案<select class="input" name="teacher" required><option value="">先按姓名查找</option></select></label>
    <p class="sm muted" data-found role="status"></p>
    <label class="field">年级<input class="input" name="grade" required maxlength="32"></label>
    <label class="field">所教班级<input class="input" name="classes" required maxlength="400" placeholder="多个班级用顿号隔开"></label>
    <label class="field">学科（选填）<input class="input" name="subject" maxlength="80"></label>`,
    async (data) => {
      const teacher = options.find((t) => t.id === data.get("teacher"));
      if (!teacher) throw Error("请先查找并选择已有老师档案。");
      const classes = String(data.get("classes"))
        .split(/[、，,\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
      await api("/teachers", null, {
        teacherId: teacher.id,
        name: teacher.name,
        grade: String(data.get("grade")).trim(),
        classes,
        subject: String(data.get("subject")).trim(),
      });
      refresh("老师档案已保存。");
    },
  );
  const select = form.elements.teacher,
    field = form.elements.q,
    message = form.querySelector("[data-found]");
  const find = async () => {
    const seq = ++search;
    options = [];
    select.replaceChildren(new Option("请选择老师", ""));
    if (!field.value.trim()) {
      message.textContent = "请输入老师姓名。";
      return;
    }
    message.textContent = "正在查询…";
    try {
      const data = await api("/teacher-options/search", null, {
        q: field.value.trim(),
      });
      if (seq !== search || !form.isConnected) return;
      options = data.items;
      for (const t of options)
        select.add(
          new Option(
            [
              t.name,
              t.scheduleName !== t.name ? t.scheduleName : "",
              t.subject,
              String(t.id).slice(-6),
            ]
              .filter(Boolean)
              .join(" · "),
            t.id,
          ),
        );
      if (options.length === 1) select.value = options[0].id;
      message.textContent = options.length
        ? "共 " + options.length + " 个档案。"
        : "未找到匹配的老师。";
    } catch (err) {
      if (seq === search) message.textContent = err.message;
    }
  };
  form.querySelector("[data-find]").onclick = find;
  field.oninput = () => {
    search++;
    options = [];
    select.replaceChildren(new Option("请重新查询", ""));
    message.textContent = "";
  };
  field.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      find();
    }
  };
}
