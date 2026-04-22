import { buildReportFromCsv } from "./report-core.js";

const state = {
  data: null,
  view: "student",
  month: "",
  entity: "",
};

const els = {
  sourceBadge: document.getElementById("sourceBadge"),
  uploadPanel: document.getElementById("uploadPanel"),
  reportPanel: document.getElementById("reportPanel"),
  dropzone: document.getElementById("dropzone"),
  csvInput: document.getElementById("csvInput"),
  studentTab: document.getElementById("studentTab"),
  teacherTab: document.getElementById("teacherTab"),
  monthSelect: document.getElementById("monthSelect"),
  entitySelect: document.getElementById("entitySelect"),
  entityLabel: document.getElementById("entityLabel"),
  resetButton: document.getElementById("resetButton"),
  exportButton: document.getElementById("exportButton"),
  summaryCards: document.getElementById("summaryCards"),
  groupTitle: document.getElementById("groupTitle"),
  groupSubtitle: document.getElementById("groupSubtitle"),
  counterpartyHeader: document.getElementById("counterpartyHeader"),
  groupRows: document.getElementById("groupRows"),
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

function currentResult() {
  return state.data?.views[state.view]?.[state.month]?.[state.entity] || null;
}

function optionsForCurrentMonth() {
  return state.data?.entityOptions[state.view]?.[state.month] || [];
}

async function handleFile(file) {
  if (!file) return;
  els.sourceBadge.textContent = `解析中：${file.name}`;
  const text = await file.text();
  state.data = buildReportFromCsv(text, file.name);
  state.view = "student";
  state.month = state.data.metadata.defaultMonth;
  state.entity = "";
  els.uploadPanel.hidden = true;
  els.reportPanel.hidden = false;
  els.sourceBadge.textContent = `${file.name} · ${number(state.data.metadata.reportableRows)} 计费行 / ${number(state.data.metadata.totalRows)} 原始行`;
  render();
}

function syncMonths() {
  els.monthSelect.innerHTML = state.data.months.map((month) => (
    `<option value="${escapeHtml(month)}" ${month === state.month ? "selected" : ""}>${escapeHtml(month)}</option>`
  )).join("");
}

function syncEntities() {
  const options = optionsForCurrentMonth();
  if (!state.entity || !options.some((option) => option.name === state.entity)) {
    state.entity = options[0]?.name || "";
  }
  els.entityLabel.textContent = state.view === "student" ? "学生" : "老师";
  els.entitySelect.innerHTML = options.map((option) => {
    const summary = `${option.name} · ${money(option.amount)} · ${number(option.duration)}h`;
    return `<option value="${escapeHtml(option.name)}" ${option.name === state.entity ? "selected" : ""}>${escapeHtml(summary)}</option>`;
  }).join("");
}

function renderSummary(result) {
  const totals = result?.totals || {};
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

function renderGroups(result) {
  els.groupTitle.textContent = result ? `${result.subjectLabel}：${result.entity}` : "无汇总";
  els.groupSubtitle.textContent = result ? `${result.month} · 金额来自原表“课程总价格”，规则金额用于校验` : "";
  els.counterpartyHeader.textContent = result?.counterpartyLabel || (state.view === "student" ? "老师" : "学生");
  els.currentIssueBadge.textContent = `${number(result?.totals?.issueCount || 0)} 个数据提醒`;
  els.currentIssueBadge.className = `badge ${(result?.totals?.issueCount || 0) ? "warn" : ""}`;

  if (!result || !result.groups.length) {
    els.groupRows.innerHTML = '<tr><td colspan="10"><div class="empty">当前筛选没有可计费课程</div></td></tr>';
    return;
  }

  els.groupRows.innerHTML = result.groups.map((group, index) => `
    <tr>
      <td><strong>${escapeHtml(group.counterparty)}</strong></td>
      <td>${escapeHtml(group.courseType)}</td>
      <td>${escapeHtml(group.teachingType)}</td>
      <td>${statusBadge(group.cancellationStatus)}</td>
      <td class="numeric">${number(group.lessons)}</td>
      <td class="numeric">${number(group.duration)}h</td>
      <td class="numeric">${number(group.cancelledDuration)}h</td>
      <td class="numeric">${escapeHtml(group.unitPriceLabel)}</td>
      <td class="numeric"><strong>${money(group.amount)}</strong></td>
      <td>
        <button class="link-button" type="button" data-group-index="${index}">${group.rawRows.length} 行明细</button>
        ${group.issueCount ? `<span class="badge warn">${group.issueCount} 提醒</span>` : ""}
      </td>
    </tr>
  `).join("");

  els.groupRows.querySelectorAll("[data-group-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = result.groups[Number(button.dataset.groupIndex)];
      openDrawer(group.rawRows, `${group.counterparty} · ${group.courseType}`, `${group.teachingType} · ${group.cancellationStatus}`);
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

function renderIssues(result) {
  const issues = result?.qualityIssues || [];
  els.issueSubtitle.textContent = `${state.month} · ${state.entity || "未选择"}`;
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
      <td class="numeric">${record.unitPrice == null ? "缺失" : money(record.unitPrice)}</td>
      <td class="numeric">${number(record.duration)}h</td>
      <td class="numeric">${money(record.sourceAmount)}</td>
      <td class="numeric">${record.expectedAmount == null ? "未配置" : money(record.expectedAmount)}</td>
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
  const result = currentResult();
  if (!result) return;
  const rows = [["主体", "月份", result.counterpartyLabel, "课程类型", "授课类型", "取消/上课状态", "课程数", "总时长", "取消时长", "课程单价", "总金额", "原始行"]];
  result.groups.forEach((group) => rows.push([
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
    group.amount,
    group.rawRows.join(" "),
  ]));
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.view}-${state.month}-${state.entity}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function render() {
  if (!state.data) return;
  els.studentTab.classList.toggle("active", state.view === "student");
  els.teacherTab.classList.toggle("active", state.view === "teacher");
  syncMonths();
  syncEntities();
  const result = currentResult();
  renderSummary(result);
  renderGroups(result);
  renderIssueCounts();
  renderIssues(result);
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
  state.entity = "";
  render();
});
els.teacherTab.addEventListener("click", () => {
  state.view = "teacher";
  state.entity = "";
  render();
});
els.monthSelect.addEventListener("change", (event) => {
  state.month = event.target.value;
  state.entity = "";
  render();
});
els.entitySelect.addEventListener("change", (event) => {
  state.entity = event.target.value;
  render();
});
els.resetButton.addEventListener("click", () => {
  state.data = null;
  els.csvInput.value = "";
  els.reportPanel.hidden = true;
  els.uploadPanel.hidden = false;
  els.sourceBadge.textContent = "等待上传 CSV";
});
els.exportButton.addEventListener("click", exportCurrentCsv);
els.closeDrawer.addEventListener("click", closeDrawer);
els.drawerBackdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});
