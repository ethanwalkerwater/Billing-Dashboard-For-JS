import JSZip from "jszip";

import teachersData from "../../data/teachers.json";
import {
  buildConfirmedReport,
  buildRequiredSelectChoices,
  collectInvalidReports,
  formatMoney,
  hasChanges,
  updateCourseLine,
  validateReport,
} from "./report-model.js";
import {
  SCORE_KEYS,
  applyTeacherOverrides,
  loadTeacherStore,
  normalizeTeacherKey,
  saveTeacherStore,
} from "./teacher-store.js";
import "./styles.css";

const state = {
  phase: "upload",
  files: {
    billing: [],
    schedule: null,
    scores: null,
  },
  reports: [],
  teachers: [],
  baseTeachers: teachersData.teachers,
  scoreTeachers: null,
  courseDrafts: {},
  teacherStore: loadTeacherStore(),
  teacherReturnPhase: "upload",
  teacherQuery: "",
  teacherForm: null,
  teacherFormError: "",
  fileStats: [],
  scoreMatch: { matched: [], unmatchedSourceNames: [] },
  selectedIndex: 0,
  loading: false,
  loadingMessage: "",
  uploadError: "",
  batch: null,
  batchValidationVisible: false,
};

state.teachers = applyTeacherOverrides(state.baseTeachers, state.teacherStore);

const app = document.querySelector("#app");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function bytes(value) {
  const number = Number(value || 0);
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
  return `${(number / 1024 / 1024).toFixed(2)} MB`;
}

function compressionLabel(file) {
  if (!file) return "";
  const saved = Math.max(0, 1 - (file.compressedSize / Math.max(file.originalSize, 1)));
  return `${bytes(file.originalSize)} → ${bytes(file.compressedSize)} · 压缩 ${Math.round(saved * 100)}%`;
}

function reportLabel(report) {
  return `${report.studentName} · ${report.month}`;
}

function canProcess() {
  return state.files.billing.length > 0 && state.files.schedule && state.files.scores;
}

const UPLOAD_FIELDS = [
  {
    kind: "billing",
    icon: "ph-student",
    title: "学生课时情况 CSV",
    hint: "每名学生的当月课时汇总（与课时账单模块使用同一份完整课时费导出），可一次多选",
    input: '<input id="billingFiles" type="file" accept=".csv,text/csv" multiple />',
  },
  {
    kind: "schedule",
    icon: "ph-calendar-dots",
    title: "完整课程 schedule.csv",
    hint: "排课系统导出的全量课表，用于交叉核对课时、单价与老师",
    input: '<input id="scheduleFile" type="file" accept=".csv,text/csv" />',
  },
  {
    kind: "scores",
    icon: "ph-chart-line-up",
    title: "老师历史累计评分 CSV",
    hint: "老师反馈模块的月度评分汇总，用于更新师资卡三项评分",
    input: '<input id="scoreFile" type="file" accept=".csv,text/csv" />',
  },
];

function uploadFieldFiles(kind) {
  if (kind === "billing") return state.files.billing;
  const file = state.files[kind];
  return file ? [file] : [];
}

function uploadFieldSummary(kind, files) {
  if (kind === "billing" && files.length > 1) {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    return `${files.length} 份 CSV · ${bytes(total)}`;
  }
  return `${files[0].name} · ${bytes(files[0].size)}`;
}

function uploadFieldCard(field) {
  const files = uploadFieldFiles(field.kind);
  const hasFile = files.length > 0;
  return `
    <label class="upload-drop ${hasFile ? "has-file" : ""}" data-upload-kind="${field.kind}">
      <span class="upload-drop-icon"><i class="ph ${field.icon}" aria-hidden="true"></i></span>
      <span class="upload-drop-body">
        <strong>${field.title}</strong>
        ${hasFile ? `
          <span class="upload-drop-file">
            <i class="ph ph-check-circle" aria-hidden="true"></i>
            ${esc(uploadFieldSummary(field.kind, files))}
          </span>
        ` : `
          <span class="upload-drop-hint">${field.hint}</span>
        `}
      </span>
      <span class="upload-drop-action">${hasFile ? "重新选择" : "点击选择或拖拽到此处"}</span>
      ${field.input}
    </label>
  `;
}

function missingUploads() {
  const missing = [];
  if (!state.files.billing.length) missing.push("学生课时情况 CSV");
  if (!state.files.schedule) missing.push("完整课程 schedule.csv");
  if (!state.files.scores) missing.push("老师历史累计评分 CSV");
  return missing;
}

function uploadScreen() {
  const missing = missingUploads();
  return `
    <main class="upload-screen">
      <section class="upload-hero">
        <div class="brand">
          <span class="brand-cn">菁仕</span>
          <span class="brand-en">King's Academy</span>
        </div>
        <p class="eyebrow">Parent Billing Studio</p>
        <h1>从三份资料，<br />生成可信的家长账单。</h1>
        <p>上传学生课时汇总、完整课程表与老师历史累计评分。所有原始 CSV 都在浏览器中解析与压缩，只有确认后的单个学生报告进入 PDF 生成。</p>
        <div class="upload-privacy">
          <i class="ph ph-shield-check" aria-hidden="true"></i>
          原始文件不保存到服务器，刷新页面后本次数据将清空。
        </div>
      </section>

      <section class="upload-form" aria-labelledby="upload-title">
        <p class="eyebrow">Step 01 · Upload</p>
        <h2 id="upload-title">上传本月资料</h2>
        <p>支持 UTF-8 CSV。学生课时情况可以一次选择多份，也可以上传包含多名学生的汇总文件。</p>

        <div class="prep-notes" role="note" aria-label="资料准备说明">
          <div class="prep-notes-head">
            <i class="ph ph-list-checks" aria-hidden="true"></i>
            <strong>资料准备说明</strong>
          </div>
          <ol>
            <li><strong>学生课时情况 CSV</strong>：当月学生课时汇总导出，可多选；也可直接使用包含多名学生的完整课时费汇总文件。</li>
            <li><strong>完整课程 schedule.csv</strong>：排课系统导出的本月全量课表，用于交叉核对课时、单价与授课老师。</li>
            <li><strong>老师历史累计评分 CSV</strong>：使用老师反馈模块 <code>cumulative/teacher_scores.csv</code>，用于更新师资卡上的三项累计评分。</li>
          </ol>
          <p>三份文件都需要是 UTF-8 编码的 CSV（用 Excel 另存时请选择「CSV UTF-8（逗号分隔）」）。</p>
        </div>

        <div class="upload-fields">
          ${UPLOAD_FIELDS.map(uploadFieldCard).join("")}
        </div>

        <div class="upload-actions">
          <div class="upload-action-notes">
            ${state.uploadError ? `<span class="upload-error" role="alert">${esc(state.uploadError)}</span>` : ""}
            ${!state.uploadError && missing.length ? `
              <span class="upload-hint">
                <i class="ph ph-info" aria-hidden="true"></i>
                还需上传：${missing.join("、")}
              </span>
            ` : ""}
            ${!state.uploadError && !missing.length ? `
              <span class="upload-hint is-ready">
                <i class="ph ph-check-circle" aria-hidden="true"></i>
                三份资料已就绪，可以开始解析
              </span>
            ` : ""}
          </div>
          <button id="manageTeachers" class="button" type="button">
            <i class="ph ph-chalkboard-teacher" aria-hidden="true"></i>
            师资库管理
          </button>
          <button id="processFiles" class="button primary" type="button" ${canProcess() ? "" : "disabled"}>
            <i class="ph ph-arrow-right" aria-hidden="true"></i>
            解析并进入校对
          </button>
        </div>
      </section>
    </main>
  `;
}

function persistTeacherStore() {
  const result = saveTeacherStore(state.teacherStore);
  if (!result.ok) {
    showToast(result.error, true);
    return false;
  }
  // 解析过 CSV 后基线应是合并了当月评分的 worker 结果，否则保存师资修改会丢评分。
  const base = state.scoreTeachers || state.baseTeachers;
  state.teachers = applyTeacherOverrides(base, state.teacherStore);
  return true;
}

function builtinPhotoUrl(teacher) {
  if (teacher.photoDataUri) return teacher.photoDataUri;
  const base = String(teacher.photo || "").replace(/\.[^.]+$/, "");
  return base ? `/${encodeURIComponent(base)}.jpg` : "";
}

function teacherAvatar(teacher) {
  const src = builtinPhotoUrl(teacher);
  const initial = esc(String(teacher.name || "?").slice(0, 1));
  if (!src) return `<span class="teacher-avatar"><span>${initial}</span></span>`;
  return `
    <span class="teacher-avatar">
      <img src="${esc(src)}" alt="${esc(teacher.name)}" loading="lazy" onerror="this.remove()" />
      <span>${initial}</span>
    </span>
  `;
}

function teacherOriginBadge(origin) {
  if (origin === "custom") return '<span class="teacher-badge is-custom">自定义</span>';
  if (origin === "modified") return '<span class="teacher-badge">已修改</span>';
  return "";
}

function scoreText(scores) {
  return SCORE_KEYS.map((key) => `${key} ${scores?.[key] ?? "—"}`).join(" · ");
}

function teacherCard(teacher, index) {
  const isCustom = teacher._origin === "custom";
  return `
    <article class="teacher-card">
      ${teacherAvatar(teacher)}
      <div class="teacher-card-body">
        <div class="teacher-card-head">
          <h3>${esc(teacher.name)}</h3>
          ${teacherOriginBadge(teacher._origin)}
        </div>
        <p class="teacher-card-tag">${esc(teacher.tag || teacher.subject || "—")}</p>
        <p class="teacher-card-desc">${esc(teacher.desc || "")}</p>
        <p class="teacher-card-scores">${esc(scoreText(teacher.scores))}</p>
      </div>
      <div class="teacher-card-actions">
        <button class="button small" type="button"
          data-teacher-action="edit"
          ${isCustom ? `data-custom-index="${index}"` : `data-teacher-key="${esc(normalizeTeacherKey(teacher.name))}"`}>
          <i class="ph ph-pencil-simple" aria-hidden="true"></i>编辑
        </button>
        <button class="button small danger" type="button"
          data-teacher-action="remove"
          ${isCustom ? `data-custom-index="${index}"` : `data-teacher-key="${esc(normalizeTeacherKey(teacher.name))}"`}>
          <i class="ph ph-${isCustom ? "trash" : "eye-slash"}" aria-hidden="true"></i>${isCustom ? "删除" : "隐藏"}
        </button>
      </div>
    </article>
  `;
}

function teacherFormPanel() {
  const form = state.teacherForm;
  if (!form) return "";
  const isNew = form.mode === "new";
  const isCustom = form.origin === "custom";
  const teacher = form.teacher;
  const photoSrc = form.photoDataUri !== undefined
    ? form.photoDataUri
    : builtinPhotoUrl(teacher);
  return `
    <section class="teacher-form" aria-labelledby="teacher-form-title">
      <div class="teacher-form-head">
        <h2 id="teacher-form-title">${isNew ? "新增老师" : `编辑：${esc(teacher.name)}`}</h2>
        <span>${isCustom || isNew ? "自定义老师只保存在本浏览器" : "内置老师的修改会覆盖默认资料"}</span>
      </div>
      <div class="teacher-form-grid">
        <label class="teacher-form-field">
          <span>姓名（必填）</span>
          <input id="tf-name" type="text" value="${esc(teacher.name)}" ${!isNew && !isCustom ? "disabled" : ""} placeholder="老师姓名" />
        </label>
        <label class="teacher-form-field">
          <span>科目</span>
          <input id="tf-subject" type="text" value="${esc(teacher.subject)}" list="teacherSubjectOptions" placeholder="如：数学" />
          <datalist id="teacherSubjectOptions">
            ${[...new Set(state.teachers.map((item) => item.subject).filter(Boolean))].map((subject) => `<option value="${esc(subject)}"></option>`).join("")}
          </datalist>
        </label>
        <label class="teacher-form-field is-wide">
          <span>标签（课程体系 / 方向）</span>
          <input id="tf-tag" type="text" value="${esc(teacher.tag)}" placeholder="如：IGCSE / A-Level / IB 数学" />
        </label>
        <label class="teacher-form-field is-wide">
          <span>简介</span>
          <textarea id="tf-desc" rows="4" placeholder="学历背景、教学风格、教学成果…">${esc(teacher.desc)}</textarea>
        </label>
        ${SCORE_KEYS.map((key, scoreIndex) => `
          <label class="teacher-form-field">
            <span>${key}评分（0–5）</span>
            <input id="tf-score-${scoreIndex}" type="number" min="0" max="5" step="0.1" value="${esc(teacher.scores?.[key] ?? "")}" placeholder="留空则不显示" />
          </label>
        `).join("")}
        <div class="teacher-form-field is-wide">
          <span>照片</span>
          <div class="teacher-photo-row">
            <span class="teacher-avatar is-large">
              ${photoSrc ? `<img src="${esc(photoSrc)}" alt="照片预览" />` : `<span>${esc(String(teacher.name || "?").slice(0, 1))}</span>`}
            </span>
            <label class="button small">
              <i class="ph ph-upload-simple" aria-hidden="true"></i>上传照片
              <input id="tf-photo" type="file" accept="image/*" />
            </label>
            ${photoSrc ? `
              <button id="tf-remove-photo" class="button small danger" type="button">
                <i class="ph ph-trash" aria-hidden="true"></i>移除照片
              </button>
            ` : ""}
            <span class="teacher-photo-note">自动压缩到最长边 800px 的 JPEG 后存入浏览器本地。</span>
          </div>
        </div>
      </div>
      ${state.teacherFormError ? `<p class="teacher-form-error" role="alert">${esc(state.teacherFormError)}</p>` : ""}
      <div class="teacher-form-actions">
        <button id="tf-cancel" class="button" type="button">取消</button>
        <button id="tf-save" class="button primary" type="button">
          <i class="ph ph-check" aria-hidden="true"></i>${isNew ? "添加老师" : "保存修改"}
        </button>
      </div>
    </section>
  `;
}

function teacherListHtml() {
  const query = state.teacherQuery.trim().toLowerCase();
  const visible = state.teachers
    .map((teacher, index) => ({ teacher, index }))
    .filter(({ teacher }) => {
      if (!query) return true;
      return [teacher.name, teacher.subject, teacher.tag]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
  const groups = new Map();
  visible.forEach(({ teacher, index }) => {
    const subject = teacher.subject || "未分科";
    if (!groups.has(subject)) groups.set(subject, []);
    groups.get(subject).push({ teacher, index });
  });
  return `
    ${[...groups.entries()].map(([subject, entries]) => `
      <section class="teacher-group">
        <h2>${esc(subject)}<span>${entries.length} 位</span></h2>
        <div class="teacher-grid">
          ${entries.map(({ teacher, index }) => teacherCard(teacher, index)).join("")}
        </div>
      </section>
    `).join("")}
    ${!visible.length ? '<p class="teacher-empty">没有匹配的老师，试试其他关键词。</p>' : ""}
  `;
}

function teacherManagerScreen() {
  const hiddenBuiltins = teachersData.teachers.filter((teacher) => (
    state.teacherStore.deleted.includes(normalizeTeacherKey(teacher.name))
  ));
  const customCount = state.teacherStore.customs.length;

  return `
    <main class="teacher-screen">
      <header class="teacher-screen-head">
        <div>
          <p class="eyebrow">Faculty Library</p>
          <h1>师资库管理</h1>
          <p class="teacher-screen-sub">
            内置 ${teachersData.teachers.length} 位老师（只读基线）· 自定义 ${customCount} 位 · 已隐藏 ${hiddenBuiltins.length} 位。
            修改只保存在本浏览器，生成 PDF 时随报告一起提交。
          </p>
        </div>
        <button id="backFromTeachers" class="button" type="button">
          <i class="ph ph-arrow-left" aria-hidden="true"></i>
          返回${state.teacherReturnPhase === "review" ? "账单核对" : "上传"}
        </button>
      </header>

      <div class="teacher-toolbar">
        <label class="teacher-search">
          <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input id="teacherSearch" type="search" value="${esc(state.teacherQuery)}" placeholder="搜索姓名、科目或标签…" />
        </label>
        <button id="addTeacher" class="button primary" type="button">
          <i class="ph ph-plus" aria-hidden="true"></i>
          新增老师
        </button>
      </div>

      ${teacherFormPanel()}

      <div id="teacherList">${teacherListHtml()}</div>

      ${hiddenBuiltins.length ? `
        <section class="teacher-group">
          <h2>已隐藏的内置老师<span>${hiddenBuiltins.length} 位</span></h2>
          <div class="teacher-hidden-list">
            ${hiddenBuiltins.map((teacher) => `
              <div class="teacher-hidden-item">
                <span>${esc(teacher.name)} · ${esc(teacher.subject || "未分科")}</span>
                <button class="button small" type="button" data-teacher-action="restore" data-teacher-key="${esc(normalizeTeacherKey(teacher.name))}">
                  <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>恢复
                </button>
              </div>
            `).join("")}
          </div>
        </section>
      ` : ""}
    </main>
  `;
}

async function compressTeacherPhoto(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.addEventListener("load", () => resolve(element), { once: true });
      element.addEventListener("error", () => reject(new Error("图片读取失败，请换一张试试")), { once: true });
      element.src = url;
    });
    const scale = Math.min(1, 800 / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUri = canvas.toDataURL("image/jpeg", 0.85);
    if (dataUri.length > 1_800_000) {
      throw new Error("照片压缩后仍超过本地存储上限，请换一张更小的图片");
    }
    return dataUri;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readScoreInput(index) {
  const raw = document.querySelector(`#tf-score-${index}`)?.value.trim() ?? "";
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || number > 5) {
    throw new Error(`${SCORE_KEYS[index]}评分必须是 0–5 之间的数字`);
  }
  return number.toFixed(1);
}

function saveTeacherForm() {
  const form = state.teacherForm;
  if (!form) return;
  try {
    const name = document.querySelector("#tf-name")?.value.trim() || "";
    const subject = document.querySelector("#tf-subject")?.value.trim() || "";
    const tag = document.querySelector("#tf-tag")?.value.trim() || "";
    const desc = document.querySelector("#tf-desc")?.value.trim() || "";
    const scores = Object.fromEntries(SCORE_KEYS.map((key, index) => [key, readScoreInput(index)]));
    if (!name) throw new Error("姓名不能为空");

    if (form.mode === "new") {
      state.teacherStore.customs.push({
        name, subject, tag, desc, scores,
        photoDataUri: form.photoDataUri || "",
      });
    } else if (form.origin === "custom") {
      const custom = state.teacherStore.customs[form.customIndex];
      if (!custom) throw new Error("这位自定义老师已被删除，请刷新后重试");
      Object.assign(custom, { subject, tag, desc, scores });
      if (form.photoDataUri !== undefined) custom.photoDataUri = form.photoDataUri;
    } else {
      const key = form.key;
      const previous = state.teacherStore.overrides[key] || {};
      const currentScores = form.teacher.scores || {};
      const scoresEdited = SCORE_KEYS.some((scoreKey) => (
        String(scores[scoreKey] ?? "") !== String(currentScores[scoreKey] ?? "")
      )) || previous.scoresEdited;
      state.teacherStore.overrides[key] = {
        subject, tag, desc, scores,
        scoresEdited,
        photoDataUri: form.photoDataUri !== undefined
          ? form.photoDataUri
          : (previous.photoDataUri || ""),
      };
    }
  } catch (error) {
    state.teacherFormError = error instanceof Error ? error.message : String(error);
    render();
    return;
  }

  if (!persistTeacherStore()) {
    render();
    return;
  }
  state.teacherForm = null;
  state.teacherFormError = "";
  render();
  showToast("师资库已更新");
}

function openTeacherForm(target) {
  const action = target.dataset.teacherAction;
  if (action === "edit" && target.dataset.customIndex !== undefined) {
    const index = Number(target.dataset.customIndex);
    const teacher = state.teachers[index];
    if (!teacher) return;
    state.teacherForm = {
      mode: "edit",
      origin: "custom",
      customIndex: state.teacherStore.customs.findIndex((item) => item.name === teacher.name),
      teacher: structuredClone(teacher),
      photoDataUri: undefined,
    };
  } else if (action === "edit") {
    const teacher = state.teachers.find((item) => normalizeTeacherKey(item.name) === target.dataset.teacherKey);
    if (!teacher) return;
    state.teacherForm = {
      mode: "edit",
      origin: "builtin",
      key: target.dataset.teacherKey,
      teacher: structuredClone(teacher),
      photoDataUri: undefined,
    };
  }
  state.teacherFormError = "";
  render();
  document.querySelector("#tf-name")?.focus();
}

function handleTeacherAction(button) {
  const action = button.dataset.teacherAction;
  if (action === "edit") {
    openTeacherForm(button);
    return;
  }
  if (action === "remove" && button.dataset.customIndex !== undefined) {
    const teacher = state.teachers[Number(button.dataset.customIndex)];
    if (!teacher) return;
    if (!window.confirm(`确定删除自定义老师「${teacher.name}」吗？此操作只影响本浏览器。`)) return;
    state.teacherStore.customs = state.teacherStore.customs.filter((item) => item.name !== teacher.name);
    if (persistTeacherStore()) {
      render();
      showToast(`已删除 ${teacher.name}`);
    }
    return;
  }
  if (action === "remove") {
    const key = button.dataset.teacherKey;
    const teacher = state.teachers.find((item) => normalizeTeacherKey(item.name) === key);
    if (!teacher) return;
    if (!window.confirm(`确定隐藏内置老师「${teacher.name}」吗？可以随时在底部恢复。`)) return;
    state.teacherStore.deleted.push(key);
    if (persistTeacherStore()) {
      render();
      showToast(`已隐藏 ${teacher.name}，可在页面底部恢复`);
    }
    return;
  }
  if (action === "restore") {
    const key = button.dataset.teacherKey;
    state.teacherStore.deleted = state.teacherStore.deleted.filter((item) => item !== key);
    if (persistTeacherStore()) {
      render();
      showToast("已恢复内置老师");
    }
  }
}

function openNewTeacherForm() {
  state.teacherForm = {
    mode: "new",
    origin: "custom",
    teacher: { name: "", subject: "", tag: "", desc: "", scores: {} },
    photoDataUri: undefined,
  };
  state.teacherFormError = "";
  render();
  document.querySelector("#tf-name")?.focus();
}

// 上传 / 移除照片会触发全量 render，先把表单里已填写但未保存的字段
// 同步回 state，避免打字内容被重建的 DOM 冲掉。
function syncTeacherFormFromDom() {
  const form = state.teacherForm;
  if (!form) return;
  const read = (selector) => document.querySelector(selector)?.value ?? "";
  form.teacher.name = read("#tf-name");
  form.teacher.subject = read("#tf-subject");
  form.teacher.tag = read("#tf-tag");
  form.teacher.desc = read("#tf-desc");
  const scores = { ...(form.teacher.scores || {}) };
  SCORE_KEYS.forEach((key, index) => {
    const raw = read(`#tf-score-${index}`).trim();
    if (raw) scores[key] = raw;
  });
  form.teacher.scores = scores;
}

function bindTeacherActionButtons(root = document) {
  root.querySelectorAll("[data-teacher-action]").forEach((button) => {
    button.addEventListener("click", () => handleTeacherAction(button));
  });
}

// 搜索时只刷新列表容器，不全量 render，否则搜索框每击键一次就丢一次焦点。
function renderTeacherList() {
  const container = document.querySelector("#teacherList");
  if (!container) return;
  container.innerHTML = teacherListHtml();
  bindTeacherActionButtons(container);
}

async function handleTeacherPhotoChange(event) {
  const file = event.currentTarget.files?.[0];
  if (!file || !state.teacherForm) return;
  syncTeacherFormFromDom();
  try {
    state.teacherForm.photoDataUri = await compressTeacherPhoto(file);
    state.teacherFormError = "";
  } catch (error) {
    state.teacherFormError = error instanceof Error ? error.message : String(error);
  }
  render();
}

function stepRail() {
  const steps = [
    ["01", "学生选择", `${state.reports.length} 份报告`],
    ["02", "上传校对", "上传完成"],
    ["03", "账单核对", "当前步骤"],
    ["04", "生成下载", "待生成"],
  ];
  return `
    <nav class="rail" aria-label="报告生成流程">
      <div class="brand">
        <span class="brand-cn">菁仕</span>
        <span class="brand-en">King's Academy</span>
      </div>
      <ol class="step-list" aria-label="生成流程">
        ${steps.map(([number, title, detail], index) => `
          <li class="step ${index < 2 ? "is-complete" : ""} ${index === 2 ? "is-current" : ""}">
            <span class="step-number">${index < 2 ? '<i class="ph ph-check" aria-hidden="true"></i>' : number}</span>
            <span class="step-copy">
              <strong>${title}</strong>
              <span>${detail}</span>
            </span>
          </li>
        `).join("")}
      </ol>
      <div class="rail-footer">
        <strong>本地会话</strong>
        <div class="privacy-note">
          <i class="ph ph-shield-check" aria-hidden="true"></i>
          <span>原始 CSV 未保存到服务器</span>
        </div>
      </div>
    </nav>
  `;
}

function teacherOptions(current) {
  const names = [...new Set(
    state.teachers.map((teacher) => teacher.name).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b, "zh-CN"));
  return requiredSelectOptions(current, names, "请选择授课老师");
}

function teachingTypeOptions(current) {
  const values = [...new Set([
    ...state.reports.flatMap((report) => report.courseLines.map((line) => line.teachingType)),
    "1v1",
    "班课",
    "刷题班",
  ].filter(Boolean))];
  return requiredSelectOptions(current, values, "请选择授课类型");
}

function requiredSelectOptions(current, values, placeholderLabel) {
  return buildRequiredSelectChoices(current, values, placeholderLabel).map((option) => (
    `<option value="${esc(option.value)}" ${option.selected ? "selected" : ""} ${option.placeholder ? "disabled" : ""}>${esc(option.label)}</option>`
  )).join("");
}

function fieldClass(line, field) {
  return line._changedFields?.includes(field) ? "field-control is-changed" : "field-control";
}

function changeDot(line, field) {
  return line._changedFields?.includes(field) ? '<span class="change-dot" aria-label="已修改"></span>' : "";
}

function originalValue(line, field, formatter = (value) => value) {
  if (!line._changedFields?.includes(field)) return "";
  return `<span class="original-value">原值：${esc(formatter(line._baseline[field]))}</span>`;
}

// 数字与原因输入框的“打字中草稿”：input 事件只写草稿，不触发全量 render，
// 否则 innerHTML 重建会销毁输入框、导致无法输入两位数。失焦/回车（change）
// 才真正提交并重渲染。render 延迟到宏任务，避免 blur 后的 click 因 DOM
// 被替换而丢失（例如改完数字直接点「确认并生成」）。
function courseDraftKey(row, field) {
  return `${state.selectedIndex}:${row}:${field}`;
}

function draftCourseValue(row, field, value) {
  state.courseDrafts[courseDraftKey(row, field)] = value;
}

function commitCourseValue(row, field, value) {
  delete state.courseDrafts[courseDraftKey(row, field)];
  state.reports[state.selectedIndex] = updateCourseLine(
    state.reports[state.selectedIndex],
    row,
    field,
    value,
  );
  setTimeout(render, 0);
}

function fieldValue(row, field, fallback) {
  return state.courseDrafts[courseDraftKey(row, field)] ?? fallback;
}

function courseRows(report) {
  return report.courseLines.map((line, index) => {
    const changed = line._changedFields?.length > 0;
    return `
      <div class="course-row" data-course-row="${index}">
        <div class="course-cell">
          <div class="${fieldClass(line, "courseType")}">
            <input
              aria-label="第 ${index + 1} 行课程名称"
              type="text"
              value="${esc(line.courseType)}"
              data-row="${index}"
              data-field="courseType"
              list="courseNameOptions"
            />
            ${changeDot(line, "courseType")}
          </div>
          ${originalValue(line, "courseType")}
        </div>
        <div class="course-cell">
          <div class="${fieldClass(line, "teacher")}">
            <select aria-label="第 ${index + 1} 行授课老师" data-row="${index}" data-field="teacher" required>
              ${teacherOptions(line.teacher)}
            </select>
            ${changeDot(line, "teacher")}
          </div>
          ${originalValue(line, "teacher")}
        </div>
        <div class="course-cell">
          <div class="${fieldClass(line, "teachingType")}">
            <select aria-label="第 ${index + 1} 行授课类型" data-row="${index}" data-field="teachingType" required>
              ${teachingTypeOptions(line.teachingType)}
            </select>
            ${changeDot(line, "teachingType")}
          </div>
          ${originalValue(line, "teachingType")}
        </div>
        <div class="course-cell">
          <div class="${fieldClass(line, "duration")}">
            <input aria-label="第 ${index + 1} 行课时" type="number" min="0" step="0.25" value="${esc(fieldValue(index, "duration", line.duration))}" data-row="${index}" data-field="duration" />
            ${changeDot(line, "duration")}
          </div>
          ${originalValue(line, "duration", (value) => `${value}h`)}
        </div>
        <div class="course-cell">
          <div class="${fieldClass(line, "unitPrice")}">
            <input aria-label="第 ${index + 1} 行课程单价" type="number" min="0" step="1" value="${esc(fieldValue(index, "unitPrice", line.unitPrice))}" data-row="${index}" data-field="unitPrice" />
            ${changeDot(line, "unitPrice")}
          </div>
          ${originalValue(line, "unitPrice", formatMoney)}
        </div>
        <div class="course-cell">
          <div class="field-control">
            <input aria-label="第 ${index + 1} 行取消比例" type="number" min="0" max="100" step="1" value="${esc(fieldValue(index, "cancellationPercent", line.cancellationPercent))}" data-row="${index}" data-field="cancellationPercent" />
          </div>
          <span class="original-value">${esc(line.status === "正常上课" ? "正常课程" : line.status)}</span>
        </div>
        <div class="course-cell payable-cell">
          <input aria-label="第 ${index + 1} 行应付金额" type="number" min="0" step="1" value="${esc(fieldValue(index, "payableAmount", line.payableAmount))}" data-row="${index}" data-field="payableAmount" />
          ${originalValue(line, "payableAmount", formatMoney)}
        </div>
        ${changed ? `
          <label class="reason-row">
            <i class="ph ph-note-pencil" aria-hidden="true"></i>
            <input
              aria-label="第 ${index + 1} 行修改原因"
              type="text"
              placeholder="${line.manualPayable ? "手动覆盖应付金额，请填写原因（必填）" : "填写修改原因（选填）"}"
              value="${esc(fieldValue(index, "adjustmentReason", line.adjustmentReason))}"
              data-row="${index}"
              data-field="adjustmentReason"
            />
          </label>
        ` : ""}
      </div>
    `;
  }).join("");
}

function fileStatuses() {
  const billingStats = state.fileStats.filter((file) => file.kind === "billing");
  const schedule = state.fileStats.find((file) => file.kind === "schedule");
  const scores = state.fileStats.find((file) => file.kind === "scores");
  const billing = billingStats.length === 1 ? billingStats[0] : {
    name: `${billingStats.length} 份学生课时 CSV`,
    originalSize: billingStats.reduce((sum, file) => sum + file.originalSize, 0),
    compressedSize: billingStats.reduce((sum, file) => sum + file.compressedSize, 0),
  };
  const files = [
    ["学生课时", billing],
    ["完整课表", schedule],
    ["老师评分", scores],
  ];
  return files.map(([label, file]) => `
    <div class="file-status">
      <i class="ph ph-check-circle" aria-hidden="true"></i>
      <span>
        <strong>${esc(label)} · ${esc(file?.name || "")}</strong>
        <span>${esc(compressionLabel(file))}</span>
      </span>
    </div>
  `).join("");
}

function issueStrip(report) {
  const issues = validateReport(report);
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  const unmatched = state.scoreMatch.unmatchedSourceNames;
  if (errors.length) {
    return `
      <div class="issue-strip is-danger" role="alert">
        <i class="ph ph-warning-circle" aria-hidden="true"></i>
        <div>
          <strong>还有 ${errors.length} 项需要处理，暂时不能生成报告</strong>
          <span>${esc(errors.slice(0, 2).map((issue) => `第 ${issue.row} 行：${issue.message}`).join("；"))}</span>
        </div>
      </div>
    `;
  }
  if (warnings.length || unmatched.length) {
    const parts = [
      ...warnings.map((issue) => issue.message),
      ...(unmatched.length ? [`${unmatched.length} 位评分老师未匹配到师资卡：${unmatched.slice(0, 3).join("、")}`] : []),
    ];
    return `
      <div class="issue-strip" role="status">
        <i class="ph ph-warning" aria-hidden="true"></i>
        <div>
          <strong>报告可以生成，但有 ${parts.length} 项提醒</strong>
          <span>${esc(parts.join("；"))}</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="issue-strip is-success" role="status">
      <i class="ph ph-check-circle" aria-hidden="true"></i>
      <div>
        <strong>数据校验通过</strong>
        <span>汇总金额、老师资料和课表均已准备好，可以生成报告。</span>
      </div>
    </div>
  `;
}

function previewPages(report) {
  return `
    <div class="preview-pages">
      <article class="preview-page" aria-label="报告封面预览">
        <div class="preview-brand"><strong>菁仕</strong><span>KING'S ACADEMY</span></div>
        <h3 class="preview-cover-name">${esc(report.studentName)}</h3>
        <div class="preview-cover-title">课时费用明细</div>
        <div class="preview-cover-bottom">
          <span>${esc(report.monthLabel)}<br />TUITION DETAIL</span>
          <strong>${esc(formatMoney(report.totals.payableAmount))}</strong>
        </div>
      </article>
      <article class="preview-page" aria-label="课程明细预览">
        <div class="preview-brand"><strong>菁仕</strong><span>KING'S ACADEMY</span></div>
        <div class="preview-bill-title">
          <h3>课程明细</h3>
          <span>01 / 04</span>
        </div>
        ${report.courseLines.map((line) => `
          <div class="mini-bill-row">
            <strong>${esc(line.courseType)}</strong>
            <span>${esc(line.duration)}h</span>
            <span>${esc(formatMoney(line.unitPrice))}</span>
            <span>${esc(formatMoney(line.payableAmount))}</span>
          </div>
        `).join("")}
        <div class="mini-total">
          <span>TOTAL PAYABLE</span>
          <strong>${esc(formatMoney(report.totals.payableAmount))}</strong>
        </div>
      </article>
    </div>
  `;
}

function batchValidationPanel(invalidReports) {
  if (!state.batchValidationVisible) return "";
  if (!invalidReports.length) {
    return `
      <section id="batchValidationPanel" class="batch-validation-panel is-success" role="status">
        <div class="batch-validation-head">
          <span class="batch-validation-icon"><i class="ph ph-check-circle" aria-hidden="true"></i></span>
          <div>
            <strong>批量校验已通过</strong>
            <span>所有报告的问题都已处理，可以再次点击“批量生成 ZIP”。</span>
          </div>
          <button id="closeBatchValidation" class="batch-validation-close" type="button" aria-label="关闭校验结果">
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
      </section>
    `;
  }

  return `
    <section id="batchValidationPanel" class="batch-validation-panel" role="alert" aria-live="assertive">
      <div class="batch-validation-head">
        <span class="batch-validation-icon"><i class="ph ph-warning-circle" aria-hidden="true"></i></span>
        <div>
          <strong>${invalidReports.length} 份报告需要处理</strong>
          <span>点击报告可直接切换到对应学员，并查看具体错误行。</span>
        </div>
        <button id="closeBatchValidation" class="batch-validation-close" type="button" aria-label="关闭错误清单">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <div class="batch-validation-list">
        ${invalidReports.map((item) => {
          const details = item.errors.slice(0, 2).map((issue) => (
            `${issue.row ? `第 ${issue.row} 行：` : ""}${issue.message}`
          ));
          if (item.errors.length > 2) details.push(`另有 ${item.errors.length - 2} 项`);
          return `
            <button class="batch-validation-item ${item.index === state.selectedIndex ? "is-current" : ""}"
              type="button" data-invalid-report-index="${item.index}">
              <span class="batch-validation-count">${item.errors.length}</span>
              <span class="batch-validation-copy">
                <strong>${esc(item.studentName)} · ${esc(item.monthLabel)}</strong>
                <span>${esc(details.join("；"))}</span>
              </span>
              <span class="batch-validation-action">前往处理 <i class="ph ph-arrow-right" aria-hidden="true"></i></span>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function reviewScreen() {
  const report = state.reports[state.selectedIndex];
  const issues = validateReport(report);
  const errors = issues.filter((issue) => issue.level === "error");
  const invalidReports = collectInvalidReports(state.reports);
  const invalidIndexes = new Set(invalidReports.map((item) => item.index));
  const courseNames = [...new Set(state.reports.flatMap((item) => (
    item.courseLines.map((line) => line.courseType)
  )))].filter(Boolean);
  const changedCount = report.courseLines.filter((line) => line._changedFields?.length).length;
  return `
    <main class="app-shell">
      ${stepRail()}
      <section class="workspace">
        <header class="workspace-head">
          <div>
            <p class="eyebrow">Billing Review</p>
            <h1>账单核对</h1>
            <p class="workspace-subtitle">只编辑学生课时 CSV 中已汇总的课程行。所有调整会立即反映在右侧报告预览中。</p>
          </div>
          <label class="student-picker">
            <span>当前学生 / 月份</span>
            <select id="studentSelect">
              ${state.reports.map((item, index) => (
                `<option value="${index}" ${index === state.selectedIndex ? "selected" : ""}>${invalidIndexes.has(index) ? "⚠ " : ""}${esc(reportLabel(item))}</option>`
              )).join("")}
            </select>
          </label>
        </header>

        <section class="upload-summary">
          <div class="section-heading">
            <h2>上传校对状态</h2>
            <span>原始 CSV 已在浏览器内完成 Gzip 压缩</span>
          </div>
          <div class="file-statuses">${fileStatuses()}</div>
        </section>

        <section class="review-section">
          <div class="student-title">
            <h2>${esc(report.studentName)}</h2>
            <span>${esc(report.monthLabel)}账单 · ${report.courseLines.length} 个课程汇总</span>
          </div>
          ${issueStrip(report)}

          <div class="section-heading">
            <h2>课程明细（可编辑汇总）</h2>
            <span>${changedCount ? `已修改 ${changedCount} 行` : "当前均为上传原值"}</span>
          </div>

          <datalist id="courseNameOptions">
            ${courseNames.map((name) => `<option value="${esc(name)}"></option>`).join("")}
          </datalist>
          <div class="ledger">
            <div class="ledger-head" aria-hidden="true">
              <span>课程名称</span>
              <span>授课老师</span>
              <span>授课类型</span>
              <span>课时 (h)</span>
              <span>课程单价</span>
              <span>取消比例</span>
              <span style="text-align:right">应付金额</span>
            </div>
            ${courseRows(report)}
          </div>

          <div class="ledger-total">
            <span>应付总额 · ${esc(report.totals.duration)}h</span>
            <strong>${esc(formatMoney(report.totals.payableAmount))}</strong>
          </div>

          ${batchValidationPanel(invalidReports)}

          <div class="workspace-actions">
            <button id="backToUpload" class="button" type="button">
              <i class="ph ph-arrow-left" aria-hidden="true"></i>
              返回上传
            </button>
            <button id="manageTeachers" class="button" type="button">
              <i class="ph ph-chalkboard-teacher" aria-hidden="true"></i>
              师资库管理
            </button>
            <div class="batch-progress" ${state.batch ? "" : "hidden"}>
              <span id="batchLabel">${esc(state.batch?.label || "")}</span>
              <div class="progress-track"><div id="batchBar" class="progress-bar" style="--progress:${state.batch?.progress || 0}%"></div></div>
            </div>
            <button id="downloadBatch" class="button" type="button" ${state.loading ? "disabled" : ""}>
              <i class="ph ph-file-zip" aria-hidden="true"></i>
              批量生成 ZIP
            </button>
            <button id="downloadSingle" class="button primary" type="button" ${errors.length || state.loading ? "disabled" : ""}>
              <i class="ph ph-file-pdf" aria-hidden="true"></i>
              确认并生成
            </button>
          </div>
        </section>
      </section>

      <aside class="preview-pane">
        <header class="preview-pane-head">
          <div>
            <h2>家长账单预览</h2>
            <p>实时预览 ${esc(report.monthLabel)} PDF 的封面与费用明细</p>
          </div>
          <button id="previewPdf" class="preview-link" type="button" ${errors.length || state.loading ? "disabled" : ""}>
            <i class="ph ph-eye" aria-hidden="true"></i>
            预览整页
          </button>
        </header>
        ${previewPages(report)}
      </aside>
    </main>
  `;
}

function loadingOverlay() {
  if (!state.loading) return "";
  return `
    <div class="loading-overlay" role="status" aria-live="polite">
      <div class="loading-panel">
        <i class="ph ph-circle-notch ph-spin" aria-hidden="true"></i>
        <strong>${esc(state.loadingMessage || "正在处理")}</strong>
        <span>请保持页面开启，这通常只需要几秒钟。</span>
      </div>
    </div>
  `;
}

function render() {
  const screen = state.phase === "upload"
    ? uploadScreen()
    : state.phase === "teachers"
      ? teacherManagerScreen()
      : reviewScreen();
  app.innerHTML = screen + loadingOverlay();
  bindEvents();
}

function bindEvents() {
  document.querySelector("#billingFiles")?.addEventListener("change", (event) => {
    state.files.billing = [...event.target.files];
    state.uploadError = "";
    render();
  });
  document.querySelector("#scheduleFile")?.addEventListener("change", (event) => {
    state.files.schedule = event.target.files[0] || null;
    state.uploadError = "";
    render();
  });
  document.querySelector("#scoreFile")?.addEventListener("change", (event) => {
    state.files.scores = event.target.files[0] || null;
    state.uploadError = "";
    render();
  });
  document.querySelectorAll(".upload-drop").forEach((zone) => {
    const kind = zone.dataset.uploadKind;
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragover");
      const files = [...(event.dataTransfer?.files || [])]
        .filter((file) => /\.csv$/i.test(file.name) || file.type.includes("csv"));
      if (!files.length) {
        state.uploadError = "请拖入 UTF-8 编码的 CSV 文件";
        render();
        return;
      }
      if (kind === "billing") state.files.billing = files;
      else state.files[kind] = files[0];
      state.uploadError = "";
      render();
    });
  });
  document.querySelector("#manageTeachers")?.addEventListener("click", () => {
    state.teacherReturnPhase = state.phase === "review" ? "review" : "upload";
    state.teacherQuery = "";
    state.teacherForm = null;
    state.teacherFormError = "";
    state.phase = "teachers";
    render();
  });
  document.querySelector("#backFromTeachers")?.addEventListener("click", () => {
    state.phase = state.teacherReturnPhase === "review" && state.reports.length ? "review" : "upload";
    state.teacherForm = null;
    state.teacherFormError = "";
    render();
  });
  document.querySelector("#addTeacher")?.addEventListener("click", openNewTeacherForm);
  document.querySelector("#teacherSearch")?.addEventListener("input", (event) => {
    state.teacherQuery = event.currentTarget.value;
    renderTeacherList();
  });
  document.querySelector("#tf-save")?.addEventListener("click", saveTeacherForm);
  document.querySelector("#tf-cancel")?.addEventListener("click", () => {
    state.teacherForm = null;
    state.teacherFormError = "";
    render();
  });
  document.querySelector("#tf-photo")?.addEventListener("change", handleTeacherPhotoChange);
  document.querySelector("#tf-remove-photo")?.addEventListener("click", () => {
    syncTeacherFormFromDom();
    if (state.teacherForm) state.teacherForm.photoDataUri = "";
    render();
  });
  bindTeacherActionButtons();
  document.querySelector("#processFiles")?.addEventListener("click", processFiles);
  document.querySelector("#studentSelect")?.addEventListener("change", (event) => {
    state.selectedIndex = Number(event.target.value);
    state.courseDrafts = {};
    render();
  });
  document.querySelector("#backToUpload")?.addEventListener("click", () => {
    state.phase = "upload";
    state.batch = null;
    state.courseDrafts = {};
    render();
  });
  document.querySelectorAll("[data-row][data-field]").forEach((control) => {
    const field = control.dataset.field;
    const isDraftField = control.type === "number" || field === "adjustmentReason";
    if (isDraftField) {
      // 数字与原因输入：击键时只写草稿 state，不做全量 render，
      // 否则重建 innerHTML 会销毁输入框、打断多位数输入；失焦/回车才正式提交。
      control.addEventListener("input", (event) => {
        draftCourseValue(Number(event.currentTarget.dataset.row), field, event.currentTarget.value);
      });
      control.addEventListener("change", (event) => {
        commitCourseValue(Number(event.currentTarget.dataset.row), field, event.currentTarget.value);
      });
    } else {
      control.addEventListener("change", (event) => {
        commitCourseValue(Number(event.currentTarget.dataset.row), field, event.currentTarget.value);
      });
    }
  });
  document.querySelector("#downloadSingle")?.addEventListener("click", async () => {
    await downloadReport(state.reports[state.selectedIndex]);
  });
  document.querySelector("#downloadBatch")?.addEventListener("click", downloadBatch);
  document.querySelector("#previewPdf")?.addEventListener("click", previewReport);
  document.querySelector("#closeBatchValidation")?.addEventListener("click", () => {
    state.batchValidationVisible = false;
    render();
  });
  document.querySelectorAll("[data-invalid-report-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedIndex = Number(button.dataset.invalidReportIndex);
      render();
      requestAnimationFrame(() => {
        document.querySelector(".issue-strip.is-danger")?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
    });
  });
}

async function readFile(file) {
  return {
    name: file.name,
    size: file.size,
    text: await file.text(),
  };
}

async function processFiles() {
  if (!canProcess()) return;
  state.loading = true;
  state.loadingMessage = "正在解析、压缩并匹配三类资料";
  state.uploadError = "";
  render();

  try {
    const [billingFiles, scheduleFile, scoreFile] = await Promise.all([
      Promise.all(state.files.billing.map(readFile)),
      readFile(state.files.schedule),
      readFile(state.files.scores),
    ]);
    const worker = new Worker(new URL("./report-worker.js", import.meta.url), { type: "module" });
    const result = await new Promise((resolve, reject) => {
      worker.addEventListener("message", (event) => resolve(event.data), { once: true });
      worker.addEventListener("error", reject, { once: true });
      worker.postMessage({ billingFiles, scheduleFile, scoreFile });
    });
    worker.terminate();
    if (!result.ok) throw new Error(result.error);

    state.reports = result.reports;
    state.scoreTeachers = result.teachers;
    // 师资库的自定义 / 覆盖 / 隐藏要贯通到核对页下拉和 PDF 提交，
    // 基线用 worker 合并了当月 CSV 评分后的列表。
    state.teachers = applyTeacherOverrides(result.teachers, state.teacherStore);
    state.courseDrafts = {};
    state.fileStats = result.files;
    state.scoreMatch = result.scoreMatch;
    state.selectedIndex = 0;
    state.phase = "review";
  } catch (error) {
    state.uploadError = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    state.loadingMessage = "";
    render();
  }
}

function reportFilename(report, extension = "pdf") {
  const safeName = String(report.studentName || "未命名学生").replace(/[\\/:*?"<>|]/g, "");
  return `${safeName}-${report.month}.${extension}`;
}

async function requestPdf(report) {
  const issues = validateReport(report).filter((issue) => issue.level === "error");
  if (issues.length) throw new Error(`${report.studentName} 还有 ${issues.length} 项错误未处理`);
  const confirmedReport = buildConfirmedReport(report);
  const response = await fetch("/api/generate-report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      report: confirmedReport,
      teachers: state.teachers,
    }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `PDF 生成失败（${response.status}）`);
  }
  return response.blob();
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function downloadReport(report) {
  state.loading = true;
  state.loadingMessage = `正在生成 ${report.studentName} 的 PDF`;
  render();
  try {
    saveBlob(await requestPdf(report), reportFilename(report));
    showToast(`${report.studentName} 的报告已生成`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.loading = false;
    state.loadingMessage = "";
    render();
  }
}

async function previewReport() {
  const popup = window.open("", "_blank");
  if (popup) {
    popup.document.write("<title>正在生成预览</title><p style='font-family:system-ui;padding:24px'>正在生成 PDF 预览…</p>");
  }
  state.loading = true;
  state.loadingMessage = "正在生成完整报告预览";
  render();
  try {
    const blob = await requestPdf(state.reports[state.selectedIndex]);
    const url = URL.createObjectURL(blob);
    if (popup) popup.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (error) {
    popup?.close();
    showToast(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.loading = false;
    state.loadingMessage = "";
    render();
  }
}

function updateBatchProgress(index, total, label) {
  const progress = Math.round((index / total) * 100);
  state.batch = { progress, label };
  const bar = document.querySelector("#batchBar");
  const text = document.querySelector("#batchLabel");
  if (bar) bar.style.setProperty("--progress", `${progress}%`);
  if (text) text.textContent = label;
}

async function downloadBatch() {
  const invalid = collectInvalidReports(state.reports);
  if (invalid.length) {
    state.batchValidationVisible = true;
    render();
    requestAnimationFrame(() => {
      document.querySelector("#batchValidationPanel")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    return;
  }

  state.batchValidationVisible = false;
  state.batch = { progress: 0, label: "准备批量生成" };
  render();
  const zip = new JSZip();
  const failures = [];

  for (let index = 0; index < state.reports.length; index += 1) {
    const report = state.reports[index];
    updateBatchProgress(index, state.reports.length, `正在生成 ${report.studentName}（${index + 1}/${state.reports.length}）`);
    try {
      zip.file(reportFilename(report), await requestPdf(report));
    } catch (error) {
      failures.push(`${report.studentName}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  updateBatchProgress(state.reports.length, state.reports.length, "正在压缩 ZIP");
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const months = [...new Set(state.reports.map((report) => report.month))].join("+");
  saveBlob(blob, `菁仕课时费明细-${months || "批量"}.zip`);
  state.batch = null;
  render();
  showToast(failures.length ? `ZIP 已生成，${failures.length} 份报告失败` : "批量报告 ZIP 已生成", failures.length > 0);
}

function showToast(message, error = false) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${error ? "is-error" : ""}`;
  toast.setAttribute("role", error ? "alert" : "status");
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 4200);
}

render();
