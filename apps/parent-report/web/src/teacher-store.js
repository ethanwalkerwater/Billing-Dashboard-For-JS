// 师资库本地维护层：data/teachers.json 是只读基线，用户的新增 / 修改 / 隐藏
// 存 localStorage（key: parent-report:teacher-overrides），加载时合并出生效列表。
//
// store 结构：
// {
//   overrides: { [normalizedName]: { subject, tag, desc, scores, scoresEdited, photoDataUri } },
//   customs:   [ { name, subject, tag, desc, scores, photoDataUri } ],
//   deleted:   [ normalizedName, ... ]          // 被隐藏的内置老师
// }
//
// 评分合并优先级：worker 合并的当月 CSV 评分 > 用户未显式修改的基线评分；
// 只有当用户在管理界面里真正改动过评分（scoresEdited=true）时，用户评分才优先。

export const TEACHER_OVERRIDES_KEY = "parent-report:teacher-overrides";

export const SCORE_KEYS = ["学习提升", "责任心", "个人魅力"];

export function normalizeTeacherKey(name) {
  return String(name ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

export function createEmptyTeacherStore() {
  return { overrides: {}, customs: [], deleted: [] };
}

function sanitizeScores(scores) {
  const clean = {};
  for (const key of SCORE_KEYS) {
    const value = scores?.[key];
    clean[key] = value == null ? null : String(value);
  }
  return clean;
}

function sanitizeStore(value) {
  const store = createEmptyTeacherStore();
  if (!value || typeof value !== "object") return store;

  if (value.overrides && typeof value.overrides === "object") {
    for (const [key, entry] of Object.entries(value.overrides)) {
      if (!entry || typeof entry !== "object") continue;
      store.overrides[key] = {
        subject: entry.subject ?? undefined,
        tag: entry.tag ?? undefined,
        desc: entry.desc ?? undefined,
        scores: sanitizeScores(entry.scores),
        scoresEdited: Boolean(entry.scoresEdited),
        photoDataUri: typeof entry.photoDataUri === "string" ? entry.photoDataUri : "",
      };
    }
  }

  if (Array.isArray(value.customs)) {
    store.customs = value.customs
      .filter((teacher) => teacher && typeof teacher === "object" && String(teacher.name || "").trim())
      .map((teacher) => ({
        name: String(teacher.name).trim(),
        subject: String(teacher.subject || ""),
        tag: String(teacher.tag || ""),
        desc: String(teacher.desc || ""),
        scores: sanitizeScores(teacher.scores),
        photoDataUri: typeof teacher.photoDataUri === "string" ? teacher.photoDataUri : "",
      }));
  }

  if (Array.isArray(value.deleted)) {
    store.deleted = [...new Set(value.deleted.map((key) => String(key)).filter(Boolean))];
  }

  return store;
}

export function loadTeacherStore(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(TEACHER_OVERRIDES_KEY);
    if (!raw) return createEmptyTeacherStore();
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return createEmptyTeacherStore();
  }
}

export function saveTeacherStore(store, storage = globalThis.localStorage) {
  if (!storage) return { ok: false, error: "当前浏览器不支持本地存储，修改无法保存" };
  try {
    storage.setItem(TEACHER_OVERRIDES_KEY, JSON.stringify(store));
    return { ok: true };
  } catch (error) {
    const quota = error && (error.name === "QuotaExceededError" || error.code === 22);
    return {
      ok: false,
      error: quota
        ? "浏览器本地存储空间不足（可能是照片过大），请移除部分自定义照片后重试"
        : `保存失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// 把 overrides / customs / deleted 合并到一份基线老师列表上。
// baseTeachers 可以是内置 teachers.json，也可以是 worker 合并过当月评分后的列表；
// 用户对内置老师的覆盖只在没有显式改过评分时才让基线评分（含当月 CSV 评分）生效。
export function applyTeacherOverrides(baseTeachers, store = createEmptyTeacherStore()) {
  const deleted = new Set(store.deleted);
  const merged = [];

  for (const teacher of baseTeachers || []) {
    const key = normalizeTeacherKey(teacher.name);
    if (!key || deleted.has(key)) continue;
    const override = store.overrides[key];
    if (!override) {
      merged.push({ ...teacher, photoDataUri: teacher.photoDataUri || "", _origin: "builtin" });
      continue;
    }
    merged.push({
      ...teacher,
      subject: override.subject ?? teacher.subject,
      tag: override.tag ?? teacher.tag,
      desc: override.desc ?? teacher.desc,
      photo: override.photoDataUri ? "" : teacher.photo,
      photoDataUri: override.photoDataUri || teacher.photoDataUri || "",
      scores: override.scoresEdited ? { ...override.scores } : teacher.scores,
      _origin: "modified",
    });
  }

  for (const custom of store.customs) {
    merged.push({
      name: custom.name,
      subject: custom.subject,
      photo: "",
      photoDataUri: custom.photoDataUri || "",
      tag: custom.tag,
      desc: custom.desc,
      scores: { ...custom.scores },
      _origin: "custom",
    });
  }

  return merged;
}
