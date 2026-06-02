import { buildReportFromCsv } from "./report-core.js";

const state = {
  data: null,
  view: "student",
  selectedMonths: [],
  selectedEntities: [],
  monthSearch: "",
  entitySearch: "",
  adjustments: {},
  sidebarCollapsed: false,
};

const els = {
  sourceBadge: document.getElementById("sourceBadge"),
  uploadPanel: document.getElementById("uploadPanel"),
  reportPanel: document.getElementById("reportPanel"),
  workspaceLayout: document.querySelector(".workspace-layout"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  dropzone: document.getElementById("dropzone"),
  csvInput: document.getElementById("csvInput"),
  studentTab: document.getElementById("studentTab"),
  teacherTab: document.getElementById("teacherTab"),
  monthSearch: document.getElementById("monthSearch"),
  monthOptions: document.getElementById("monthOptions"),
  monthChips: document.getElementById("monthChips"),
  entitySearch: document.getElementById("entitySearch"),
  entityOptions: document.getElementById("entityOptions"),
  entityChips: document.getElementById("entityChips"),
  entityLabel: document.getElementById("entityLabel"),
  resetButton: document.getElementById("resetButton"),
  exportButton: document.getElementById("exportButton"),
  summaryCards: document.getElementById("summaryCards"),
  groupTitle: document.getElementById("groupTitle"),
  groupSubtitle: document.getElementById("groupSubtitle"),
  groupSections: document.getElementById("groupSections"),
  currentIssueBadge: document.getElementById("currentIssueBadge"),
  issueCounts: document.getElementById("issueCounts"),
  issueSubtitle: document.getElementById("issueSubtitle"),
  issueRows: document.getElementById("issueRows"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  detailDrawer: document.getElementById("detailDrawer"),
  closeDrawer: document.getElementById("closeDrawer"),
  drawerTitle: document.getElementById("drawerTitle"),
  drawerSubtitle: document.getElementById("drawerSubtitle"),
  drawerRows: document.getElementById("drawerRows"),
};

function money(value) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(value || 0);
}

function moneyValue(value) {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}

function number(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value || 0);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function selectedMonths() {
  return state.data.months.filter((month) => state.selectedMonths.includes(month));
}

function entityOptionsForSelectedMonths() {
  const byName = new Map();
  for (const month of selectedMonths()) {
    for (const option of state.data.entityOptions[state.view]?.[month] || []) {
      const current = byName.get(option.name) || { name: option.name, amount: 0, duration: 0, lessons: 0, cancelledLessons: 0 };
      current.amount += option.amount || 0;
      current.duration += option.duration || 0;
      current.lessons += option.lessons || 0;
      current.cancelledLessons += option.cancelledLessons || 0;
      byName.set(option.name, current);
    }
  }
  return [...byName.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"));
}

function selectedEntityOptions() {
  const options = entityOptionsForSelectedMonths();
  return options.filter((option) => state.selectedEntities.includes(option.name));
}

function currentResults() {
  const results = [];
  for (const entity of state.selectedEntities) {
    for (const month of selectedMonths()) {
      const result = state.data.views[state.view]?.[month]?.[entity];
      if (result) results.push(result);
    }
  }
  return results;
}

function combinedTotals(results) {
  return results.reduce((totals, result) => ({
    lessons: totals.lessons + result.totals.lessons,
    duration: totals.duration + result.totals.duration,
    amount: totals.amount + result.totals.amount,
    cancelledLessons: totals.cancelledLessons + result.totals.cancelledLessons,
    cancelledDuration: totals.cancelledDuration + result.totals.cancelledDuration,
    cancelledAmount: totals.cancelledAmount + result.totals.cancelledAmount,
    issueCount: totals.issueCount + result.totals.issueCount,
  }), {
    lessons: 0,
    duration: 0,
    amount: 0,
    cancelledLessons: 0,
    cancelledDuration: 0,
    cancelledAmount: 0,
    issueCount: 0,
  });
}

function groupAdjustmentKey(result, group) {
  return JSON.stringify([
    result.view,
    result.month,
    result.entity,
    group.counterparty,
    group.courseType,
    group.teachingType,
    group.cancellationStatus,
  ]);
}

function getAdjustment(key) {
  if (!state.adjustments[key]) {
    state.adjustments[key] = { discountPercent: "100", reason: "" };
  }
  return state.adjustments[key];
}

function actualAmount(amount, discountPercent) {
  const discount = Number(discountPercent);
  return (amount || 0) * (Number.isFinite(discount) ? discount : 0) / 100;
}

async function handleFile(file) {
  if (!file) return;
  els.sourceBadge.textContent = `解析中：${file.name}`;
  const text = await file.text();
  state.data = buildReportFromCsv(text, file.name);
  state.view = "student";
  state.selectedMonths = state.data.metadata.defaultMonth ? [state.data.metadata.defaultMonth] : [];
  state.selectedEntities = [];
  state.monthSearch = "";
  state.entitySearch = "";
  state.adjustments = {};
  state.sidebarCollapsed = false;
  els.monthSearch.value = "";
  els.entitySearch.value = "";
  els.uploadPanel.hidden = true;
  els.reportPanel.hidden = false;
  els.sourceBadge.textContent = `${file.name} · ${number(state.data.metadata.reportableRows)} 计费行 / ${number(state.data.metadata.totalRows)} 原始行`;
  render();
}

function renderSidebarState() {
  els.workspaceLayout.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  els.sidebarToggle.textContent = state.sidebarCollapsed ? ">" : "<";
  els.sidebarToggle.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
  els.sidebarToggle.setAttribute("aria-label", state.sidebarCollapsed ? "展开筛选" : "收起筛选");
}

function ensureValidSelections() {
  state.selectedMonths = state.selectedMonths.filter((month) => state.data.months.includes(month));
  if (!state.selectedMonths.length && state.data.months.length) {
    state.selectedMonths = [state.data.metadata.defaultMonth || state.data.months.at(-1)];
  }

  const options = entityOptionsForSelectedMonths();
  const optionNames = new Set(options.map((option) => option.name));
  state.selectedEntities = state.selectedEntities.filter((entity) => optionNames.has(entity));
  if (!state.selectedEntities.length && options.length) {
    state.selectedEntities = [options[0].name];
  }
}

function renderMonthOptions() {
  const search = state.monthSearch.trim().toLowerCase();
  const months = state.data.months.filter((month) => month.toLowerCase().includes(search));
  els.monthOptions.innerHTML = months.length ? months.map((month) => `
    <label class="picker-option">
      <input type="checkbox" value="${escapeHtml(month)}" ${state.selectedMonths.includes(month) ? "checked" : ""} data-month-option />
      <span>${escapeHtml(month)}</span>
    </label>
  `).join("") : '<div class="empty">没有匹配月份</div>';

  els.monthOptions.querySelectorAll("[data-month-option]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.selectedMonths = [...new Set([...state.selectedMonths, input.value])].sort();
      } else {
        state.selectedMonths = state.selectedMonths.filter((month) => month !== input.value);
      }
      ensureValidSelections();
      render();
    });
  });
}

function renderEntityOptions() {
  const options = entityOptionsForSelectedMonths();
  const search = state.entitySearch.trim().toLowerCase();
  const visibleOptions = options.filter((option) => option.name.toLowerCase().includes(search));
  const entityName = state.view === "student" ? "学生" : "老师";
  els.entityLabel.textContent = entityName;
  els.entitySearch.placeholder = `搜索${entityName}`;
  els.entityOptions.innerHTML = visibleOptions.length ? visibleOptions.map((option) => {
    const summary = `${option.name} · ${money(option.amount)} · ${number(option.duration)}h`;
    return `
      <label class="picker-option">
        <input type="checkbox" value="${escapeHtml(option.name)}" ${state.selectedEntities.includes(option.name) ? "checked" : ""} data-entity-option />
        <span>${escapeHtml(summary)}</span>
      </label>
    `;
  }).join("") : `<div class="empty">没有匹配${escapeHtml(entityName)}</div>`;

  els.entityOptions.querySelectorAll("[data-entity-option]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.selectedEntities = [...new Set([...state.selectedEntities, input.value])];
      } else {
        state.selectedEntities = state.selectedEntities.filter((entity) => entity !== input.value);
      }
      render();
    });
  });
}

function renderSelectionChips() {
  const entityName = state.view === "student" ? "学生" : "老师";
  els.monthChips.innerHTML = state.selectedMonths.length ? state.selectedMonths.map((month) => `
    <span class="selection-chip">
      <span>${escapeHtml(month)}</span>
      <button type="button" data-chip-type="month" data-chip-value="${escapeHtml(month)}" aria-label="移除月份 ${escapeHtml(month)}">x</button>
    </span>
  `).join("") : '<span class="selection-empty">未选择月份</span>';

  els.entityChips.innerHTML = state.selectedEntities.length ? state.selectedEntities.map((entity) => `
    <span class="selection-chip">
      <span>${escapeHtml(entity)}</span>
      <button type="button" data-chip-type="entity" data-chip-value="${escapeHtml(entity)}" aria-label="移除${escapeHtml(entityName)} ${escapeHtml(entity)}">x</button>
    </span>
  `).join("") : `<span class="selection-empty">未选择${escapeHtml(entityName)}</span>`;

  [...els.monthChips.querySelectorAll("[data-chip-type]"), ...els.entityChips.querySelectorAll("[data-chip-type]")].forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.chipType === "month") {
        state.selectedMonths = state.selectedMonths.filter((month) => month !== button.dataset.chipValue);
        ensureValidSelections();
      } else {
        state.selectedEntities = state.selectedEntities.filter((entity) => entity !== button.dataset.chipValue);
      }
      render();
    });
  });
}

function renderSummary(results) {
  const totals = combinedTotals(results);
  const cards = [
    ["总金额", money(totals.amount), `${number(totals.duration)} 小时`],
    ["课程数", number(totals.lessons), "进入计费汇总的原始课程"],
    ["临时取消金额", money(totals.cancelledAmount), `${number(totals.cancelledDuration)} 取消小时`],
    ["临时取消课程", number(totals.cancelledLessons), "按取消比例收费"],
    ["数据提醒", number(totals.issueCount), "当前筛选范围"],
  ];
  els.summaryCards.innerHTML = cards.map(([label, value, sub]) => `
    <article class="card metric">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-sub">${escapeHtml(sub)}</div>
    </article>
  `).join("");
}

function statusBadge(status) {
  if (status === "正常上课") return '<span class="badge">正常上课</span>';
  if (String(status).includes("%")) return `<span class="badge warn">${escapeHtml(status)}</span>`;
  return `<span class="badge danger">${escapeHtml(status)}</span>`;
}

function renderGroups(results) {
  const totals = combinedTotals(results);
  const entityName = state.view === "student" ? "学生" : "老师";
  const selectedEntities = selectedEntityOptions();
  els.groupTitle.textContent = results.length === 1
    ? `${results[0].subjectLabel}：${results[0].entity}`
    : `${entityName}：${selectedEntities.length} 个`;
  els.groupSubtitle.textContent = `${selectedMonths().join("、") || "未选择月份"} · 金额来自原表“课程总价格”，规则金额用于校验`;
  els.currentIssueBadge.textContent = `${number(totals.issueCount)} 个数据提醒`;
  els.currentIssueBadge.className = `badge ${totals.issueCount ? "warn" : ""}`;

  if (!results.length || !results.some((result) => result.groups.length)) {
    els.groupSections.innerHTML = '<div class="empty">当前筛选没有可计费课程</div>';
    return;
  }

  els.groupSections.innerHTML = results.map((result, resultIndex) => `
    <section class="result-section">
      <div class="result-section-head">
        <div>
          <div class="result-section-title">${escapeHtml(result.subjectLabel)}：${escapeHtml(result.entity)}</div>
          <div class="result-section-meta">${escapeHtml(result.month)} · ${number(result.totals.lessons)} 课 · ${money(result.totals.amount)}</div>
        </div>
        ${result.totals.issueCount ? `<span class="badge warn">${number(result.totals.issueCount)} 个数据提醒</span>` : ""}
      </div>
      <div class="table-wrap">
        <table>
          <colgroup>
            <col style="width: 82px" />
            <col style="width: 92px" />
            <col style="width: 72px" />
            <col style="width: 96px" />
            <col style="width: 58px" />
            <col style="width: 80px" />
            <col style="width: 86px" />
            <col style="width: 84px" />
            <col style="width: 78px" />
            <col style="width: 120px" />
            <col style="width: 94px" />
            <col style="width: 94px" />
            <col style="width: 96px" />
          </colgroup>
          <thead>
            <tr>
              <th>${escapeHtml(result.counterpartyLabel)}</th>
              <th>课程类型</th>
              <th>授课类型</th>
              <th>取消/上课状态</th>
              <th class="numeric">课程数</th>
              <th class="numeric">总时长（h）</th>
              <th class="numeric">取消时长（h）</th>
              <th class="numeric">课程单价（¥）</th>
              <th class="numeric">折扣（%）</th>
              <th>折扣原因</th>
              <th class="numeric">总金额（¥）</th>
              <th class="numeric">实际金额（¥）</th>
              <th>原始数据</th>
            </tr>
          </thead>
          <tbody>
            ${result.groups.map((group, groupIndex) => {
              const adjustment = getAdjustment(groupAdjustmentKey(result, group));
              return `
                <tr>
                  <td><strong>${escapeHtml(group.counterparty)}</strong></td>
                  <td>${escapeHtml(group.courseType)}</td>
                  <td>${escapeHtml(group.teachingType)}</td>
                  <td>${statusBadge(group.cancellationStatus)}</td>
                  <td class="numeric">${number(group.lessons)}</td>
                  <td class="numeric">${number(group.duration)}</td>
                  <td class="numeric">${number(group.cancelledDuration)}</td>
                  <td class="numeric">${escapeHtml(group.unitPriceLabel)}</td>
                  <td class="numeric">
                    <input class="table-input number-input" type="number" step="0.01" value="${escapeHtml(adjustment.discountPercent)}" data-discount-input data-result-index="${resultIndex}" data-group-index="${groupIndex}" aria-label="折扣百分比" />
                  </td>
                  <td>
                    <input class="table-input reason-input" type="text" value="${escapeHtml(adjustment.reason)}" data-discount-reason data-result-index="${resultIndex}" data-group-index="${groupIndex}" aria-label="折扣原因" />
                  </td>
                  <td class="numeric"><strong>${moneyValue(group.amount)}</strong></td>
                  <td class="numeric"><strong data-actual-amount="${resultIndex}-${groupIndex}">${moneyValue(actualAmount(group.amount, adjustment.discountPercent))}</strong></td>
                  <td>
                    <button class="link-button" type="button" data-detail-result-index="${resultIndex}" data-detail-group-index="${groupIndex}">${group.rawRows.length} 行明细</button>
                    ${group.issueCount ? `<span class="badge warn">${group.issueCount} 提醒</span>` : ""}
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `).join("");

  els.groupSections.querySelectorAll("[data-detail-result-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const result = results[Number(button.dataset.detailResultIndex)];
      const group = result.groups[Number(button.dataset.detailGroupIndex)];
      openDrawer(group.rawRows, `${result.entity} · ${group.counterparty} · ${group.courseType}`, `${result.month} · ${group.teachingType} · ${group.cancellationStatus}`);
    });
  });
  els.groupSections.querySelectorAll("[data-discount-input]").forEach((input) => {
    input.addEventListener("input", () => {
      const result = results[Number(input.dataset.resultIndex)];
      const group = result.groups[Number(input.dataset.groupIndex)];
      const adjustment = getAdjustment(groupAdjustmentKey(result, group));
      adjustment.discountPercent = input.value;
      const actual = els.groupSections.querySelector(`[data-actual-amount="${input.dataset.resultIndex}-${input.dataset.groupIndex}"]`);
      if (actual) actual.textContent = moneyValue(actualAmount(group.amount, adjustment.discountPercent));
    });
  });
  els.groupSections.querySelectorAll("[data-discount-reason]").forEach((input) => {
    input.addEventListener("input", () => {
      const result = results[Number(input.dataset.resultIndex)];
      const group = result.groups[Number(input.dataset.groupIndex)];
      getAdjustment(groupAdjustmentKey(result, group)).reason = input.value;
    });
  });
}

function renderIssueCounts() {
  const entries = Object.entries(state.data.issueCounts).sort((a, b) => b[1] - a[1]);
  els.issueCounts.innerHTML = entries.length ? entries.map(([code, count]) => `
    <div class="issue-row">
      <span>${escapeHtml(state.data.issueLabels[code] || code)}</span>
      <strong>${number(count)}</strong>
    </div>
  `).join("") : '<div class="empty">全表没有数据提醒</div>';
}

function renderIssues(results) {
  const issues = results.flatMap((result) => result.qualityIssues);
  els.issueSubtitle.textContent = `${selectedMonths().join("、") || "未选择月份"} · ${state.selectedEntities.join("、") || "未选择"}`;
  if (!issues.length) {
    els.issueRows.innerHTML = '<tr><td colspan="7"><div class="empty">当前筛选范围没有数据提醒</div></td></tr>';
    return;
  }
  els.issueRows.innerHTML = issues.slice(0, 240).map((issue) => {
    const record = state.data.recordsByRow[String(issue.rawRow)] || {};
    return `
      <tr>
        <td><button class="link-button" type="button" data-raw-row="${issue.rawRow}">#${issue.rawRow}</button></td>
        <td><span class="badge warn">${escapeHtml(issue.label)}</span></td>
        <td>${escapeHtml(record.student || "")}</td>
        <td>${escapeHtml(record.teacher || "")}</td>
        <td>${escapeHtml(record.courseType || "")}</td>
        <td>${escapeHtml(record.date || "")}</td>
        <td>${escapeHtml(issue.message)}</td>
      </tr>
    `;
  }).join("");
  els.issueRows.querySelectorAll("[data-raw-row]").forEach((button) => {
    button.addEventListener("click", () => openDrawer([Number(button.dataset.rawRow)], `原始行 #${button.dataset.rawRow}`, "数据提醒"));
  });
}

function openDrawer(rawRows, title, subtitle) {
  const rows = rawRows.map((row) => state.data.recordsByRow[String(row)]).filter(Boolean);
  els.drawerTitle.textContent = title;
  els.drawerSubtitle.textContent = `${subtitle} · ${rows.length} 行`;
  els.drawerRows.innerHTML = rows.map((record) => `
    <tr>
      <td>#${record.rawRow}</td>
      <td>${escapeHtml(record.date)} ${escapeHtml(record.weekday)}</td>
      <td>${escapeHtml(record.startTime)}-${escapeHtml(record.endTime)}</td>
      <td>${escapeHtml(record.student)}</td>
      <td>${escapeHtml(record.teacher)}</td>
      <td>${escapeHtml(record.courseType)}</td>
      <td>${escapeHtml(record.teachingType)}</td>
      <td>${statusBadge(record.cancellationStatus)}</td>
      <td class="numeric">${record.unitPrice == null ? "缺失" : moneyValue(record.unitPrice)}</td>
      <td class="numeric">${number(record.duration)}</td>
      <td class="numeric">${moneyValue(record.sourceAmount)}</td>
      <td class="numeric">${record.expectedAmount == null ? "未配置" : moneyValue(record.expectedAmount)}</td>
      <td>${escapeHtml(record.location)}</td>
      <td>${record.issues.map((issue) => `<span class="badge warn">${escapeHtml(issue.label)}</span>`).join(" ")}</td>
    </tr>
  `).join("");
  els.drawerBackdrop.classList.add("open");
  els.detailDrawer.classList.add("open");
  els.detailDrawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  els.drawerBackdrop.classList.remove("open");
  els.detailDrawer.classList.remove("open");
  els.detailDrawer.setAttribute("aria-hidden", "true");
}

function exportCurrentCsv() {
  const results = currentResults();
  if (!results.length) return;
  const rows = [[`${results[0].subjectLabel}名`, "月份", results[0]?.counterpartyLabel || "", "课程类型", "授课类型", "取消/上课状态", "课程数", "总时长（h）", "取消时长（h）", "课程单价（¥）", "折扣（%）", "折扣原因", "总金额（¥）", "实际金额（¥）", "原始行"]];
  results.forEach((result) => {
    result.groups.forEach((group) => {
      const adjustment = getAdjustment(groupAdjustmentKey(result, group));
      rows.push([
        result.entity,
        result.month,
        group.counterparty,
        group.courseType,
        group.teachingType,
        group.cancellationStatus,
        group.lessons,
        group.duration,
        group.cancelledDuration,
        group.unitPriceLabel,
        adjustment.discountPercent,
        adjustment.reason,
        group.amount,
        actualAmount(group.amount, adjustment.discountPercent),
        group.rawRows.join(" "),
      ]);
    });
  });
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.view}-${selectedMonths().join("+")}-${state.selectedEntities.join("+")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function render() {
  if (!state.data) return;
  ensureValidSelections();
  els.studentTab.classList.toggle("active", state.view === "student");
  els.teacherTab.classList.toggle("active", state.view === "teacher");
  renderSidebarState();
  renderMonthOptions();
  renderEntityOptions();
  renderSelectionChips();
  const results = currentResults();
  renderSummary(results);
  renderGroups(results);
  renderIssueCounts();
  renderIssues(results);
}

els.csvInput.addEventListener("change", (event) => handleFile(event.target.files[0]));
els.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.dropzone.classList.add("dragging");
});
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragging"));
els.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  els.dropzone.classList.remove("dragging");
  handleFile(event.dataTransfer.files[0]);
});
els.studentTab.addEventListener("click", () => {
  state.view = "student";
  state.selectedEntities = [];
  state.entitySearch = "";
  els.entitySearch.value = "";
  render();
});
els.teacherTab.addEventListener("click", () => {
  state.view = "teacher";
  state.selectedEntities = [];
  state.entitySearch = "";
  els.entitySearch.value = "";
  render();
});
els.monthSearch.addEventListener("input", (event) => {
  state.monthSearch = event.target.value;
  renderMonthOptions();
});
els.entitySearch.addEventListener("input", (event) => {
  state.entitySearch = event.target.value;
  renderEntityOptions();
});
els.resetButton.addEventListener("click", () => {
  state.data = null;
  state.selectedMonths = [];
  state.selectedEntities = [];
  state.monthSearch = "";
  state.entitySearch = "";
  state.adjustments = {};
  state.sidebarCollapsed = false;
  els.monthSearch.value = "";
  els.entitySearch.value = "";
  els.csvInput.value = "";
  els.reportPanel.hidden = true;
  els.uploadPanel.hidden = false;
  els.sourceBadge.textContent = "等待上传 CSV";
});
els.sidebarToggle.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  renderSidebarState();
});
els.exportButton.addEventListener("click", exportCurrentCsv);
els.closeDrawer.addEventListener("click", closeDrawer);
els.drawerBackdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});
