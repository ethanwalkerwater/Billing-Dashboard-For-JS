import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const f = (rel) => path.resolve(APP_ROOT, rel);

for (const file of [
  "web/index.html",
  "web/assets/app.js",
  "web/assets/styles.css",
  "web/assets/report-core.js",
  "web/assets/payroll-core.js",
]) {
  assert.ok(fs.existsSync(f(file)), `${file} is missing`);
}

const html = fs.readFileSync(f("web/index.html"), "utf8");
assert.match(html, /lessonFeeInput/, "must upload downstream lesson fee CSV");
assert.match(html, /taxSocialInput/, "must upload tax and social insurance CSV");
assert.match(html, /reimbursementInput/, "must upload reimbursement CSV");
assert.match(html, /masterCards/, "must expose editable master data cards");
assert.match(html, /monthSelect/, "must expose selectable payroll month");
assert.match(html, /teacherSelect/, "must expose selectable payroll teacher");
assert.match(html, /exportSelectedButton/, "must expose selected teacher export");
assert.match(html, /exportAllButton/, "must expose monthly summary export");
assert.match(html, /data-template/, "must expose CSV template downloads");
assert.match(html, /addMasterRowButton/, "must support adding master data rows");
assert.match(html, /ledgerPanel/, "must render income ledger panel");

const app = fs.readFileSync(f("web/assets/app.js"), "utf8");
assert.match(app, /buildPayrollReport/, "must calculate payroll through billing-core");
assert.match(app, /nameAliases: state\.master\.nameAliases/, "local defaults must pass custom name aliases to payroll core");
assert.match(app, /openMasterEditor/, "master data must be editable");
assert.match(app, /addMasterRow/, "master data editor must support new rows");
assert.match(app, /renderLedger/, "must render add/subtotal ledger");
assert.match(app, /renderMonthSelect/, "must render month selector");
assert.match(app, /renderTeacherSelect/, "must render teacher selector");
assert.match(app, /setupCombobox/, "month/teacher selectors must be searchable comboboxes");
assert.match(app, /renderLessonDetails/, "must render lesson fee details");
assert.match(app, /data-lesson-discount/, "lesson fee details must keep editable discounts");
assert.match(app, /parseTaxSocialCsv/, "must parse tax/social table");
assert.match(app, /downloadTemplate/, "must download CSV templates");
assert.match(app, /exportSelectedTeacher/, "must export selected teacher detail");
assert.match(app, /exportAllTeachers/, "must export monthly teacher summary");

const css = fs.readFileSync(f("web/assets/styles.css"), "utf8");
assert.match(css, /\.ledger/, "ledger must be styled");
assert.match(css, /\.lesson-table/, "lesson detail table must be styled");
assert.match(css, /\.master-card/, "master data cards must be styled");
assert.match(css, /\.combo-list/, "searchable combobox must be styled");
assert.match(css, /\.template-grid/, "template download buttons must be styled");
assert.match(css, /\.control-actions/, "output action controls must be styled");

console.log("teacher income static app verification ok");
