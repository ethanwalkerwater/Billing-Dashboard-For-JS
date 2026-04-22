#!/usr/bin/env python3
"""Generate an interactive course billing report from the schedule CSV."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Any


DEFAULT_INPUT = Path("data/raw/schedule.csv")
DEFAULT_OUTPUT = Path("outputs/course_billing_report/course_billing_report.html")

CANCELLATION_RATES = {
    "0h-70%": 0.7,
    "2h-50%": 0.5,
    "6h-30%": 0.3,
}

NORMAL_STATUS = "正常上课"
MISSING_TEACHER = "未填写老师"
MISSING_STUDENT = "未填写学生"
MISSING_COURSE = "未填写课程类型"
MISSING_TEACHING_TYPE = "未填写授课类型"

ISSUE_LABELS = {
    "missing_student": "缺少学生",
    "missing_teacher": "缺少老师",
    "missing_course_type": "缺少课程类型",
    "missing_teaching_type": "缺少授课类型",
    "missing_start_time": "缺少上课时间",
    "invalid_start_time": "上课时间无法解析",
    "missing_unit_price": "缺少课程单价",
    "missing_duration": "缺少课程时长",
    "missing_amount": "缺少课程总价格",
    "unknown_cancellation": "未知取消标记",
    "amount_mismatch": "金额与规则不一致",
    "not_reportable": "未进入计费汇总",
}


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value).replace("\r", " ").replace("\n", " ").strip()


def parse_number(value: Any) -> float | None:
    text = clean_text(value).replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_datetime(value: Any) -> datetime | None:
    text = clean_text(value)
    if not text:
        return None
    for fmt in ("%Y/%m/%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def split_students(student_text: str) -> list[str]:
    parts = [clean_text(part) for part in re.split(r"[,，、]", student_text)]
    return [part for part in parts if part]


def parse_cancellation_rate(label: str) -> float | None:
    return CANCELLATION_RATES.get(clean_text(label))


def _round_money(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value + 0, 6)


def _format_date(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d") if dt else ""


def _format_time(dt: datetime | None) -> str:
    return dt.strftime("%H:%M") if dt else ""


def _weekday(dt: datetime | None) -> str:
    if not dt:
        return ""
    return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][dt.weekday()]


def normalize_row(row: dict[str, Any], raw_row_number: int) -> dict[str, Any]:
    course_type = clean_text(row.get("课程类型"))
    teacher = clean_text(row.get("老师"))
    student = clean_text(row.get("学生"))
    teaching_type = clean_text(row.get("授课类型"))
    cancellation = clean_text(row.get("临时取消"))
    start_dt = parse_datetime(row.get("上课时间"))
    end_dt = parse_datetime(row.get("下课时间"))
    unit_price = parse_number(row.get("课程单价"))
    duration = parse_number(row.get("课程时长"))
    source_amount = parse_number(row.get("课程总价格"))
    cancellation_rate = parse_cancellation_rate(cancellation)
    is_cancelled = bool(cancellation)

    expected_amount: float | None = None
    if unit_price is not None and duration is not None:
        if is_cancelled and cancellation_rate is None:
            expected_amount = None
        else:
            expected_amount = unit_price * duration * (cancellation_rate if is_cancelled else 1)

    amount = source_amount if source_amount is not None else expected_amount
    amount_diff: float | None = None
    if source_amount is not None and expected_amount is not None:
        amount_diff = source_amount - expected_amount

    issues: list[dict[str, Any]] = []

    def add_issue(code: str, message: str) -> None:
        issues.append({"code": code, "label": ISSUE_LABELS[code], "message": message, "rawRow": raw_row_number})

    if not student:
        add_issue("missing_student", "学生为空，无法准确进入学生收费视图。")
    if not teacher:
        add_issue("missing_teacher", "老师为空，老师收入视图无法归属。")
    if not course_type:
        add_issue("missing_course_type", "课程类型为空，汇总会归入未填写课程类型。")
    if not teaching_type:
        add_issue("missing_teaching_type", "授课类型为空，汇总会归入未填写授课类型。")
    raw_start = clean_text(row.get("上课时间"))
    if not raw_start:
        add_issue("missing_start_time", "上课时间为空，无法按月份筛选。")
    elif start_dt is None:
        add_issue("invalid_start_time", f"上课时间无法解析：{raw_start}")
    if unit_price is None and (source_amount or 0) != 0:
        add_issue("missing_unit_price", "存在收费金额但课程单价为空。")
    if duration is None:
        add_issue("missing_duration", "课程时长为空或无法解析。")
    if source_amount is None:
        add_issue("missing_amount", "课程总价格为空或无法解析。")
    if is_cancelled and cancellation_rate is None:
        add_issue("unknown_cancellation", f"临时取消标记未配置收费比例：{cancellation}")
    if amount_diff is not None and abs(amount_diff) > 0.01:
        add_issue(
            "amount_mismatch",
            f"原表金额 {source_amount:g} 与规则计算 {expected_amount:g} 相差 {amount_diff:g}。",
        )

    reportable = bool(start_dt) and (
        bool(teacher)
        or unit_price is not None
        or abs(source_amount or 0) > 0.000001
        or bool(cancellation)
    )
    if not reportable:
        add_issue("not_reportable", "没有老师、单价、收费金额或取消标记，已排除在计费汇总之外。")

    return {
        "rawRow": raw_row_number,
        "courseId": clean_text(row.get("学员课程ID")),
        "teacherCourseId": clean_text(row.get("老师课程ID")),
        "scheduleId": clean_text(row.get("日程 ID")),
        "month": start_dt.strftime("%Y-%m") if start_dt else "",
        "date": _format_date(start_dt),
        "weekday": _weekday(start_dt),
        "startTime": _format_time(start_dt),
        "endTime": _format_time(end_dt),
        "student": student,
        "studentList": split_students(student),
        "teacher": teacher,
        "courseType": course_type,
        "teachingType": teaching_type,
        "location": clean_text(row.get("上课地点")),
        "unitPrice": _round_money(unit_price),
        "duration": _round_money(duration),
        "sourceAmount": _round_money(source_amount),
        "expectedAmount": _round_money(expected_amount),
        "amount": _round_money(amount) or 0,
        "amountDiff": _round_money(amount_diff),
        "cancellationRaw": cancellation,
        "cancellationStatus": cancellation if is_cancelled else NORMAL_STATUS,
        "cancellationRate": cancellation_rate,
        "isCancelled": is_cancelled,
        "reportable": reportable,
        "issues": issues,
    }


def _sum(values: list[float | int | None]) -> float:
    return round(sum(float(v or 0) for v in values), 6)


def _price_label(prices: list[float]) -> str:
    unique = sorted({round(price, 6) for price in prices})
    if not unique:
        return "缺失"
    return " / ".join(f"¥{price:,.2f}".rstrip("0").rstrip(".") for price in unique)


def aggregate_records(records: list[dict[str, Any]], view: str, month: str, entity: str) -> dict[str, Any]:
    if view not in {"student", "teacher"}:
        raise ValueError("view must be 'student' or 'teacher'")

    if view == "student":
        matched = [
            record
            for record in records
            if record["reportable"] and record["month"] == month and entity in record["studentList"]
        ]
        counterparty_field = "teacher"
        empty_counterparty = MISSING_TEACHER
        subject_label = "学生"
        counterparty_label = "老师"
    else:
        matched = [
            record
            for record in records
            if record["reportable"] and record["month"] == month and record["teacher"] == entity
        ]
        counterparty_field = "student"
        empty_counterparty = MISSING_STUDENT
        subject_label = "老师"
        counterparty_label = "学生"

    grouped: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for record in matched:
        counterparty = record[counterparty_field] or empty_counterparty
        course_type = record["courseType"] or MISSING_COURSE
        teaching_type = record["teachingType"] or MISSING_TEACHING_TYPE
        grouped[(counterparty, course_type, teaching_type, record["cancellationStatus"])].append(record)

    groups = []
    for (counterparty, course_type, teaching_type, cancellation_status), rows in grouped.items():
        prices = [row["unitPrice"] for row in rows if row["unitPrice"] is not None]
        amount = _sum([row["amount"] for row in rows])
        duration = _sum([row["duration"] for row in rows])
        cancelled_rows = [row for row in rows if row["isCancelled"]]
        issue_count = sum(len(row["issues"]) for row in rows)
        groups.append(
            {
                "counterparty": counterparty,
                "courseType": course_type,
                "teachingType": teaching_type,
                "cancellationStatus": cancellation_status,
                "lessons": len(rows),
                "duration": duration,
                "cancelledDuration": _sum([row["duration"] for row in cancelled_rows]),
                "amount": amount,
                "cancelledAmount": _sum([row["amount"] for row in cancelled_rows]),
                "unitPrices": sorted({price for price in prices}),
                "unitPriceLabel": _price_label(prices),
                "rawRows": sorted(row["rawRow"] for row in rows),
                "issueCount": issue_count,
            }
        )

    groups.sort(key=lambda group: (group["counterparty"], group["courseType"], group["teachingType"], group["cancellationStatus"]))

    quality_issues = []
    for record in matched:
        quality_issues.extend(record["issues"])

    totals = {
        "lessons": len(matched),
        "duration": _sum([record["duration"] for record in matched]),
        "amount": _sum([record["amount"] for record in matched]),
        "cancelledLessons": sum(1 for record in matched if record["isCancelled"]),
        "cancelledDuration": _sum([record["duration"] for record in matched if record["isCancelled"]]),
        "cancelledAmount": _sum([record["amount"] for record in matched if record["isCancelled"]]),
        "issueCount": len(quality_issues),
    }

    return {
        "view": view,
        "month": month,
        "entity": entity,
        "subjectLabel": subject_label,
        "counterpartyLabel": counterparty_label,
        "groups": groups,
        "totals": totals,
        "qualityIssues": quality_issues,
    }


def read_csv_records(input_path: Path) -> list[dict[str, Any]]:
    with input_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [normalize_row(row, index + 2) for index, row in enumerate(reader)]


def _all_quality_issues(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    issues = []
    for record in records:
        for issue in record["issues"]:
            copy = dict(issue)
            copy.update(
                {
                    "month": record["month"],
                    "student": record["student"],
                    "teacher": record["teacher"],
                    "courseType": record["courseType"],
                    "date": record["date"],
                    "amount": record["amount"],
                }
            )
            issues.append(copy)
    return issues


def build_report_data(records: list[dict[str, Any]], source_path: Path) -> dict[str, Any]:
    months = sorted({record["month"] for record in records if record["month"]})
    current_month = datetime.now().strftime("%Y-%m")
    default_month = current_month if current_month in months else (months[-1] if months else "")

    students = sorted({student for record in records for student in record["studentList"]})
    teachers = sorted({record["teacher"] for record in records if record["teacher"]})
    views: dict[str, dict[str, dict[str, dict[str, Any]]]] = {"student": {}, "teacher": {}}
    entity_options: dict[str, dict[str, list[dict[str, Any]]]] = {"student": {}, "teacher": {}}

    for view, entities in (("student", students), ("teacher", teachers)):
        for month in months:
            views[view][month] = {}
            options = []
            for entity in entities:
                result = aggregate_records(records, view, month, entity)
                if result["totals"]["lessons"] == 0:
                    continue
                views[view][month][entity] = result
                options.append(
                    {
                        "name": entity,
                        "amount": result["totals"]["amount"],
                        "duration": result["totals"]["duration"],
                        "lessons": result["totals"]["lessons"],
                        "cancelledLessons": result["totals"]["cancelledLessons"],
                    }
                )
            options.sort(key=lambda option: (-option["amount"], option["name"]))
            entity_options[view][month] = options

    records_by_row = {str(record["rawRow"]): record for record in records}
    issue_counts: dict[str, int] = defaultdict(int)
    for issue in _all_quality_issues(records):
        issue_counts[issue["code"]] += 1

    return {
        "metadata": {
            "sourcePath": str(source_path),
            "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "totalRows": len(records),
            "reportableRows": sum(1 for record in records if record["reportable"]),
            "excludedRows": sum(1 for record in records if not record["reportable"]),
            "knownCancellationRates": CANCELLATION_RATES,
            "defaultMonth": default_month,
        },
        "months": months,
        "defaultView": "student",
        "views": views,
        "entityOptions": entity_options,
        "recordsByRow": records_by_row,
        "qualityIssues": _all_quality_issues(records),
        "issueCounts": dict(sorted(issue_counts.items())),
        "issueLabels": ISSUE_LABELS,
    }


def render_html(report_data: dict[str, Any]) -> str:
    data_json = json.dumps(report_data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    source_name = escape(Path(report_data["metadata"]["sourcePath"]).name)
    generated_at = escape(report_data["metadata"]["generatedAt"])
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>月度课时收费报表</title>
  <style>
    :root {{
      color-scheme: light;
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --border: 214.3 31.8% 91.4%;
      --input: 214.3 31.8% 91.4%;
      --primary: 222.2 47.4% 11.2%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
      --ring: 222.2 84% 4.9%;
      --radius: 8px;
      --warn: 38 92% 50%;
      --ok: 142 71% 45%;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }}
    button, input, select {{
      font: inherit;
    }}
    .shell {{
      width: min(1440px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }}
    .header {{
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 24px;
    }}
    .eyebrow {{
      color: hsl(var(--muted-foreground));
      font-size: 13px;
      margin: 0 0 6px;
    }}
    h1 {{
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: 0;
    }}
    .meta {{
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      max-width: 560px;
    }}
    .badge {{
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid hsl(var(--border));
      border-radius: 999px;
      padding: 2px 8px;
      background: hsl(var(--secondary));
      color: hsl(var(--secondary-foreground));
      white-space: nowrap;
    }}
    .badge.warn {{
      border-color: hsl(var(--warn) / .36);
      background: hsl(var(--warn) / .12);
      color: hsl(25 95% 24%);
    }}
    .badge.danger {{
      border-color: hsl(var(--destructive) / .28);
      background: hsl(var(--destructive) / .10);
      color: hsl(0 72% 38%);
    }}
    .toolbar {{
      display: grid;
      grid-template-columns: auto minmax(160px, 220px) minmax(280px, 1fr) auto;
      align-items: end;
      gap: 12px;
      padding: 14px;
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      background: hsl(var(--card));
      box-shadow: 0 1px 2px hsl(222.2 84% 4.9% / .05);
      margin-bottom: 16px;
    }}
    .field {{
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }}
    .field label {{
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      font-weight: 500;
    }}
    .control {{
      height: 38px;
      width: 100%;
      border: 1px solid hsl(var(--input));
      border-radius: 6px;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      padding: 0 10px;
      outline: none;
    }}
    .control:focus {{
      border-color: hsl(var(--ring));
      box-shadow: 0 0 0 2px hsl(var(--ring) / .12);
    }}
    .segmented {{
      display: inline-grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      border: 1px solid hsl(var(--border));
      border-radius: 8px;
      background: hsl(var(--muted));
      padding: 4px;
      min-width: 220px;
    }}
    .segmented button, .button {{
      height: 36px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: hsl(var(--muted-foreground));
      cursor: pointer;
      padding: 0 12px;
      white-space: nowrap;
    }}
    .segmented button.active, .button.primary {{
      background: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      box-shadow: 0 1px 2px hsl(222.2 84% 4.9% / .12);
    }}
    .button.outline {{
      border-color: hsl(var(--border));
      background: hsl(var(--background));
      color: hsl(var(--foreground));
    }}
    .summary {{
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }}
    .card {{
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      background: hsl(var(--card));
      box-shadow: 0 1px 2px hsl(222.2 84% 4.9% / .05);
    }}
    .metric {{
      padding: 14px;
      min-height: 96px;
    }}
    .metric-label {{
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      margin-bottom: 8px;
    }}
    .metric-value {{
      font-size: 24px;
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: 0;
    }}
    .metric-sub {{
      margin-top: 4px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }}
    .panel {{
      overflow: hidden;
      margin-bottom: 16px;
    }}
    .panel-head {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid hsl(var(--border));
    }}
    .panel-title {{
      font-weight: 650;
      font-size: 15px;
    }}
    .panel-subtitle {{
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }}
    .table-wrap {{
      overflow: auto;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }}
    th, td {{
      padding: 10px 12px;
      border-bottom: 1px solid hsl(var(--border));
      text-align: left;
      vertical-align: top;
    }}
    th {{
      position: sticky;
      top: 0;
      z-index: 1;
      background: hsl(var(--muted));
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      font-weight: 600;
    }}
    td.numeric, th.numeric {{
      text-align: right;
      font-variant-numeric: tabular-nums;
    }}
    tr:hover td {{
      background: hsl(var(--accent));
    }}
    .link-button {{
      border: 0;
      background: transparent;
      color: hsl(221 83% 45%);
      cursor: pointer;
      padding: 0;
      font-weight: 600;
    }}
    .muted {{
      color: hsl(var(--muted-foreground));
    }}
    .empty {{
      padding: 48px 16px;
      text-align: center;
      color: hsl(var(--muted-foreground));
    }}
    .quality-grid {{
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 16px;
      align-items: start;
    }}
    .issue-list {{
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
    }}
    .issue-row {{
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid hsl(var(--border));
      border-radius: 6px;
    }}
    .drawer-backdrop {{
      position: fixed;
      inset: 0;
      display: none;
      background: hsl(222.2 84% 4.9% / .34);
      z-index: 20;
    }}
    .drawer {{
      position: fixed;
      inset: 0 0 0 auto;
      width: min(940px, 94vw);
      display: none;
      flex-direction: column;
      background: hsl(var(--popover));
      color: hsl(var(--popover-foreground));
      border-left: 1px solid hsl(var(--border));
      box-shadow: -16px 0 42px hsl(222.2 84% 4.9% / .18);
      z-index: 21;
    }}
    .drawer.open, .drawer-backdrop.open {{
      display: flex;
    }}
    .drawer-backdrop.open {{
      display: block;
    }}
    .drawer-head {{
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px;
      border-bottom: 1px solid hsl(var(--border));
    }}
    .drawer-body {{
      overflow: auto;
      padding: 0 18px 18px;
    }}
    .raw-table {{
      min-width: 1120px;
    }}
    .raw-table th {{
      top: 0;
    }}
    @media (max-width: 980px) {{
      .header, .meta {{
        justify-content: flex-start;
      }}
      .header {{
        flex-direction: column;
      }}
      .toolbar {{
        grid-template-columns: 1fr;
      }}
      .segmented {{
        width: 100%;
      }}
      .summary {{
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }}
      .quality-grid {{
        grid-template-columns: 1fr;
      }}
    }}
    @media (max-width: 640px) {{
      .shell {{
        width: min(100vw - 20px, 1440px);
        padding-top: 18px;
      }}
      h1 {{
        font-size: 22px;
      }}
      .summary {{
        grid-template-columns: 1fr;
      }}
      .metric-value {{
        font-size: 21px;
      }}
    }}
  </style>
</head>
<body>
  <main class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">Course Billing Report</p>
        <h1>月度课时收费与老师收入</h1>
      </div>
      <div class="meta">
        <span class="badge">源文件：{source_name}</span>
        <span class="badge">生成时间：{generated_at}</span>
        <span class="badge" id="rowStats">读取中</span>
      </div>
    </header>

    <section class="toolbar" aria-label="筛选">
      <div class="segmented" role="tablist" aria-label="视图切换">
        <button id="studentTab" type="button" class="active" data-view="student">学生收费</button>
        <button id="teacherTab" type="button" data-view="teacher">老师收入</button>
      </div>
      <div class="field">
        <label for="monthSelect">月份</label>
        <select id="monthSelect" class="control"></select>
      </div>
      <div class="field">
        <label id="entityLabel" for="entitySelect">学生</label>
        <select id="entitySelect" class="control"></select>
      </div>
      <button id="exportButton" class="button outline" type="button">导出当前汇总 CSV</button>
    </section>

    <section class="summary" id="summaryCards"></section>

    <section class="card panel">
      <div class="panel-head">
        <div>
          <div class="panel-title" id="groupTitle">汇总</div>
          <div class="panel-subtitle" id="groupSubtitle"></div>
        </div>
        <span class="badge" id="currentIssueBadge">0 个数据提醒</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th id="counterpartyHeader">老师</th>
              <th>课程类型</th>
              <th>授课类型</th>
              <th>取消/上课状态</th>
              <th class="numeric">课程数</th>
              <th class="numeric">总时长</th>
              <th class="numeric">取消时长</th>
              <th class="numeric">课程单价</th>
              <th class="numeric">总金额</th>
              <th>原始数据</th>
            </tr>
          </thead>
          <tbody id="groupRows"></tbody>
        </table>
      </div>
    </section>

    <section class="quality-grid">
      <aside class="card">
        <div class="panel-head">
          <div>
            <div class="panel-title">全表数据质量</div>
            <div class="panel-subtitle">按原始行号追溯</div>
          </div>
        </div>
        <div class="issue-list" id="issueCounts"></div>
      </aside>
      <section class="card panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">当前筛选的数据提醒</div>
            <div class="panel-subtitle" id="issueSubtitle"></div>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>原始行</th>
                <th>问题</th>
                <th>学生</th>
                <th>老师</th>
                <th>课程</th>
                <th>日期</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody id="issueRows"></tbody>
          </table>
        </div>
      </section>
    </section>
  </main>

  <div id="drawerBackdrop" class="drawer-backdrop"></div>
  <aside id="detailDrawer" class="drawer" aria-label="原始数据明细" aria-hidden="true">
    <div class="drawer-head">
      <div>
        <div class="panel-title" id="drawerTitle">原始数据</div>
        <div class="panel-subtitle" id="drawerSubtitle"></div>
      </div>
      <button id="closeDrawer" type="button" class="button outline">关闭</button>
    </div>
    <div class="drawer-body">
      <div class="table-wrap">
        <table class="raw-table">
          <thead>
            <tr>
              <th>原始行</th>
              <th>日期</th>
              <th>时间</th>
              <th>学生</th>
              <th>老师</th>
              <th>课程类型</th>
              <th>授课类型</th>
              <th>状态</th>
              <th class="numeric">单价</th>
              <th class="numeric">时长</th>
              <th class="numeric">原表金额</th>
              <th class="numeric">规则金额</th>
              <th>地点</th>
              <th>问题</th>
            </tr>
          </thead>
          <tbody id="drawerRows"></tbody>
        </table>
      </div>
    </div>
  </aside>

  <script>
    const REPORT_DATA = {data_json};
    const state = {{
      view: REPORT_DATA.defaultView,
      month: REPORT_DATA.metadata.defaultMonth,
      entity: "",
    }};

    const els = {{
      rowStats: document.getElementById("rowStats"),
      monthSelect: document.getElementById("monthSelect"),
      entitySelect: document.getElementById("entitySelect"),
      entityLabel: document.getElementById("entityLabel"),
      studentTab: document.getElementById("studentTab"),
      teacherTab: document.getElementById("teacherTab"),
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
    }};

    function money(value) {{
      return new Intl.NumberFormat("zh-CN", {{ style: "currency", currency: "CNY", maximumFractionDigits: 2 }}).format(value || 0);
    }}

    function number(value) {{
      return new Intl.NumberFormat("zh-CN", {{ maximumFractionDigits: 2 }}).format(value || 0);
    }}

    function escapeHtml(value) {{
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({{
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }}[char]));
    }}

    function currentResult() {{
      return REPORT_DATA.views[state.view]?.[state.month]?.[state.entity] || null;
    }}

    function optionsForCurrentMonth() {{
      return REPORT_DATA.entityOptions[state.view]?.[state.month] || [];
    }}

    function setView(view) {{
      state.view = view;
      state.entity = "";
      render();
    }}

    function syncMonths() {{
      els.monthSelect.innerHTML = REPORT_DATA.months.map((month) => (
        `<option value="${{escapeHtml(month)}}" ${{month === state.month ? "selected" : ""}}>${{escapeHtml(month)}}</option>`
      )).join("");
    }}

    function syncEntities() {{
      const options = optionsForCurrentMonth();
      if (!state.entity || !options.some((option) => option.name === state.entity)) {{
        state.entity = options[0]?.name || "";
      }}
      els.entityLabel.textContent = state.view === "student" ? "学生" : "老师";
      els.entitySelect.innerHTML = options.map((option) => {{
        const summary = `${{option.name}} · ${{money(option.amount)}} · ${{number(option.duration)}}h`;
        return `<option value="${{escapeHtml(option.name)}}" ${{option.name === state.entity ? "selected" : ""}}>${{escapeHtml(summary)}}</option>`;
      }}).join("");
    }}

    function renderSummary(result) {{
      const totals = result?.totals || {{}};
      const cards = [
        ["总金额", money(totals.amount), `${{number(totals.duration)}} 小时`],
        ["课程数", number(totals.lessons), "进入计费汇总的原始课程"],
        ["临时取消金额", money(totals.cancelledAmount), `${{number(totals.cancelledDuration)}} 取消小时`],
        ["临时取消课程", number(totals.cancelledLessons), "按取消比例收费"],
        ["数据提醒", number(totals.issueCount), "当前筛选范围"],
      ];
      els.summaryCards.innerHTML = cards.map(([label, value, sub]) => `
        <article class="card metric">
          <div class="metric-label">${{escapeHtml(label)}}</div>
          <div class="metric-value">${{escapeHtml(value)}}</div>
          <div class="metric-sub">${{escapeHtml(sub)}}</div>
        </article>
      `).join("");
    }}

    function statusBadge(status) {{
      if (status === "正常上课") return `<span class="badge">正常上课</span>`;
      if (status.includes("%")) return `<span class="badge warn">${{escapeHtml(status)}}</span>`;
      return `<span class="badge danger">${{escapeHtml(status)}}</span>`;
    }}

    function renderGroups(result) {{
      els.groupTitle.textContent = result ? `${{result.subjectLabel}}：${{result.entity}}` : "无汇总";
      els.groupSubtitle.textContent = result ? `${{result.month}} · 金额来自原表“课程总价格”，规则金额用于校验` : "";
      els.counterpartyHeader.textContent = result?.counterpartyLabel || (state.view === "student" ? "老师" : "学生");
      els.currentIssueBadge.textContent = `${{number(result?.totals?.issueCount || 0)}} 个数据提醒`;
      els.currentIssueBadge.className = `badge ${{(result?.totals?.issueCount || 0) ? "warn" : ""}}`;

      if (!result || !result.groups.length) {{
        els.groupRows.innerHTML = `<tr><td colspan="10"><div class="empty">当前筛选没有可计费课程</div></td></tr>`;
        return;
      }}

      els.groupRows.innerHTML = result.groups.map((group, index) => `
        <tr>
          <td><strong>${{escapeHtml(group.counterparty)}}</strong></td>
          <td>${{escapeHtml(group.courseType)}}</td>
          <td>${{escapeHtml(group.teachingType)}}</td>
          <td>${{statusBadge(group.cancellationStatus)}}</td>
          <td class="numeric">${{number(group.lessons)}}</td>
          <td class="numeric">${{number(group.duration)}}h</td>
          <td class="numeric">${{number(group.cancelledDuration)}}h</td>
          <td class="numeric">${{escapeHtml(group.unitPriceLabel)}}</td>
          <td class="numeric"><strong>${{money(group.amount)}}</strong></td>
          <td>
            <button class="link-button" type="button" data-group-index="${{index}}">
              ${{group.rawRows.length}} 行明细
            </button>
            ${{group.issueCount ? `<span class="badge warn">${{group.issueCount}} 提醒</span>` : ""}}
          </td>
        </tr>
      `).join("");

      els.groupRows.querySelectorAll("[data-group-index]").forEach((button) => {{
        button.addEventListener("click", () => {{
          const group = result.groups[Number(button.dataset.groupIndex)];
          openDrawer(group.rawRows, `${{group.counterparty}} · ${{group.courseType}}`, `${{group.teachingType}} · ${{group.cancellationStatus}}`);
        }});
      }});
    }}

    function renderIssueCounts() {{
      const counts = REPORT_DATA.issueCounts;
      const labels = REPORT_DATA.issueLabels;
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      els.issueCounts.innerHTML = entries.map(([code, count]) => `
        <div class="issue-row">
          <span>${{escapeHtml(labels[code] || code)}}</span>
          <strong>${{number(count)}}</strong>
        </div>
      `).join("");
      els.rowStats.textContent = `${{number(REPORT_DATA.metadata.reportableRows)}} 计费行 / ${{number(REPORT_DATA.metadata.totalRows)}} 原始行`;
    }}

    function renderIssues(result) {{
      const issues = result?.qualityIssues || [];
      els.issueSubtitle.textContent = `${{state.month}} · ${{state.entity || "未选择"}}`;
      if (!issues.length) {{
        els.issueRows.innerHTML = `<tr><td colspan="7"><div class="empty">当前筛选范围没有数据提醒</div></td></tr>`;
        return;
      }}
      els.issueRows.innerHTML = issues.slice(0, 240).map((issue) => {{
        const record = REPORT_DATA.recordsByRow[String(issue.rawRow)] || {{}};
        return `
          <tr>
            <td><button class="link-button" type="button" data-raw-row="${{issue.rawRow}}">#${{issue.rawRow}}</button></td>
            <td><span class="badge warn">${{escapeHtml(issue.label)}}</span></td>
            <td>${{escapeHtml(record.student || "")}}</td>
            <td>${{escapeHtml(record.teacher || "")}}</td>
            <td>${{escapeHtml(record.courseType || "")}}</td>
            <td>${{escapeHtml(record.date || "")}}</td>
            <td>${{escapeHtml(issue.message)}}</td>
          </tr>
        `;
      }}).join("");
      els.issueRows.querySelectorAll("[data-raw-row]").forEach((button) => {{
        button.addEventListener("click", () => openDrawer([Number(button.dataset.rawRow)], `原始行 #${{button.dataset.rawRow}}`, "数据提醒"));
      }});
    }}

    function openDrawer(rawRows, title, subtitle) {{
      const rows = rawRows.map((row) => REPORT_DATA.recordsByRow[String(row)]).filter(Boolean);
      els.drawerTitle.textContent = title;
      els.drawerSubtitle.textContent = `${{subtitle}} · ${{rows.length}} 行`;
      els.drawerRows.innerHTML = rows.map((record) => `
        <tr>
          <td>#${{record.rawRow}}</td>
          <td>${{escapeHtml(record.date)}} ${{escapeHtml(record.weekday)}}</td>
          <td>${{escapeHtml(record.startTime)}}-${{escapeHtml(record.endTime)}}</td>
          <td>${{escapeHtml(record.student)}}</td>
          <td>${{escapeHtml(record.teacher)}}</td>
          <td>${{escapeHtml(record.courseType)}}</td>
          <td>${{escapeHtml(record.teachingType)}}</td>
          <td>${{statusBadge(record.cancellationStatus)}}</td>
          <td class="numeric">${{record.unitPrice == null ? "缺失" : money(record.unitPrice)}}</td>
          <td class="numeric">${{number(record.duration)}}h</td>
          <td class="numeric">${{money(record.sourceAmount)}}</td>
          <td class="numeric">${{record.expectedAmount == null ? "未配置" : money(record.expectedAmount)}}</td>
          <td>${{escapeHtml(record.location)}}</td>
          <td>${{record.issues.map((issue) => `<span class="badge warn">${{escapeHtml(issue.label)}}</span>`).join(" ")}}</td>
        </tr>
      `).join("");
      els.drawerBackdrop.classList.add("open");
      els.detailDrawer.classList.add("open");
      els.detailDrawer.setAttribute("aria-hidden", "false");
    }}

    function closeDrawer() {{
      els.drawerBackdrop.classList.remove("open");
      els.detailDrawer.classList.remove("open");
      els.detailDrawer.setAttribute("aria-hidden", "true");
    }}

    function exportCurrentCsv() {{
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
      const csv = rows.map((row) => row.map((cell) => `"${{String(cell).replaceAll('"', '""')}}"`).join(",")).join("\\n");
      const blob = new Blob(["\\ufeff", csv], {{ type: "text/csv;charset=utf-8" }});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${{state.view}}-${{state.month}}-${{state.entity}}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    }}

    function render() {{
      els.studentTab.classList.toggle("active", state.view === "student");
      els.teacherTab.classList.toggle("active", state.view === "teacher");
      syncMonths();
      syncEntities();
      const result = currentResult();
      renderSummary(result);
      renderGroups(result);
      renderIssueCounts();
      renderIssues(result);
    }}

    els.studentTab.addEventListener("click", () => setView("student"));
    els.teacherTab.addEventListener("click", () => setView("teacher"));
    els.monthSelect.addEventListener("change", (event) => {{
      state.month = event.target.value;
      state.entity = "";
      render();
    }});
    els.entitySelect.addEventListener("change", (event) => {{
      state.entity = event.target.value;
      render();
    }});
    els.exportButton.addEventListener("click", exportCurrentCsv);
    els.closeDrawer.addEventListener("click", closeDrawer);
    els.drawerBackdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (event) => {{
      if (event.key === "Escape") closeDrawer();
    }});

    render();
  </script>
</body>
</html>
"""


def write_report(input_path: Path, output_path: Path) -> dict[str, Any]:
    records = read_csv_records(input_path)
    report_data = build_report_data(records, input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_html(report_data), encoding="utf-8")
    return report_data


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a monthly course billing HTML report.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Source schedule CSV.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output HTML path.")
    args = parser.parse_args()
    report_data = write_report(args.input, args.output)
    print(f"Wrote {args.output}")
    print(
        json.dumps(
            {
                "totalRows": report_data["metadata"]["totalRows"],
                "reportableRows": report_data["metadata"]["reportableRows"],
                "months": report_data["months"],
                "issueCounts": report_data["issueCounts"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
