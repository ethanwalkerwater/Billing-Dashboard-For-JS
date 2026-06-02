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
    return " / ".join(f"{price:,.2f}".rstrip("0").rstrip(".") for price in unique)


def _cancellation_order(status: str) -> int:
    return 0 if status == NORMAL_STATUS else 1


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

    groups.sort(
        key=lambda group: (
            _cancellation_order(group["cancellationStatus"]),
            group["counterparty"],
            group["courseType"],
            group["teachingType"],
            group["cancellationStatus"],
        )
    )

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
      --background: 210 40% 98%;
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
    [hidden] {{
      display: none !important;
    }}
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
      width: min(1600px, calc(100vw - 32px));
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
    .workspace-layout {{
      display: grid;
      grid-template-columns: 276px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }}
    .workspace-layout.sidebar-collapsed {{
      grid-template-columns: 52px minmax(0, 1fr);
    }}
    .sidebar-panel {{
      position: sticky;
      top: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 14px;
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      background: hsl(var(--card));
      box-shadow: 0 1px 2px hsl(222.2 84% 4.9% / .05);
    }}
    .sidebar-head {{
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }}
    .sidebar-head strong {{
      display: block;
      font-size: 14px;
    }}
    .sidebar-body {{
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 16px;
    }}
    .workspace-layout.sidebar-collapsed .sidebar-panel {{
      align-items: center;
      gap: 0;
      padding: 8px;
    }}
    .workspace-layout.sidebar-collapsed .sidebar-head > div,
    .workspace-layout.sidebar-collapsed .sidebar-body {{
      display: none;
    }}
    .sidebar-section {{
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }}
    .sidebar-actions {{
      padding-top: 4px;
    }}
    .content-panel {{
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 16px;
    }}
    .content-actionbar {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 76px;
      padding: 16px;
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      background: hsl(var(--card));
      box-shadow: 0 1px 2px hsl(222.2 84% 4.9% / .05);
    }}
    .content-actionbar .panel-title {{
      font-size: 18px;
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
    .control, .picker-search {{
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
    .picker-search:focus {{
      border-color: hsl(var(--ring));
      box-shadow: 0 0 0 2px hsl(var(--ring) / .12);
    }}
    .picker-options {{
      height: 148px;
      overflow-y: auto;
      overflow-x: hidden;
      border: 1px solid hsl(var(--border));
      border-radius: 6px;
      background: hsl(var(--background));
    }}
    .picker-option {{
      display: flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      padding: 0 10px;
      border-bottom: 1px solid hsl(var(--border));
      cursor: pointer;
    }}
    .picker-option:last-child {{
      border-bottom: 0;
    }}
    .picker-option:hover {{
      background: hsl(var(--accent));
    }}
    .picker-option input {{
      width: 16px;
      height: 16px;
      margin: 0;
    }}
    .picker-option span {{
      min-width: 0;
      overflow: hidden;
      color: hsl(var(--foreground));
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .selection-chips {{
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 28px;
    }}
    .selection-chip {{
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      height: 28px;
      gap: 6px;
      padding: 0 8px;
      border: 1px solid hsl(221 83% 53% / .26);
      border-radius: 999px;
      background: hsl(221 83% 53% / .08);
      color: hsl(221 83% 30%);
      font-size: 12px;
      line-height: 1;
    }}
    .selection-chip span {{
      min-width: 0;
      overflow: hidden;
      color: inherit;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .selection-chip button {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 0;
    }}
    .selection-chip button:hover {{
      background: hsl(221 83% 53% / .14);
    }}
    .selection-empty {{
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
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
    .icon-button {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      flex: 0 0 auto;
      border: 1px solid hsl(var(--border));
      border-radius: 6px;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      cursor: pointer;
      padding: 0;
    }}
    .icon-button:hover {{
      background: hsl(var(--accent));
    }}
    .filter-grid {{
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
      align-items: start;
      min-width: 0;
    }}
    .summary {{
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
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
    .result-sections {{
      display: flex;
      flex-direction: column;
    }}
    .result-section {{
      border-top: 1px solid hsl(var(--border));
    }}
    .result-section:first-child {{
      border-top: 0;
    }}
    .result-section-head {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      background: hsl(var(--background));
    }}
    .result-section-title {{
      font-weight: 700;
    }}
    .result-section-meta {{
      margin-top: 2px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
    }}
    .result-section table {{
      min-width: 1120px;
      table-layout: fixed;
    }}
    th, td {{
      padding: 8px 10px;
      border-bottom: 1px solid hsl(var(--border));
      text-align: left;
      vertical-align: top;
      line-height: 1.35;
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
    .table-input {{
      width: 100%;
      height: 30px;
      border: 1px solid hsl(var(--input));
      border-radius: 6px;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      padding: 0 8px;
      outline: none;
    }}
    .table-input:focus {{
      border-color: hsl(var(--ring));
      box-shadow: 0 0 0 2px hsl(var(--ring) / .12);
    }}
    .number-input {{
      max-width: 78px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }}
    .reason-input {{
      max-width: 120px;
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
      .workspace-layout, .filter-grid {{
        grid-template-columns: 1fr;
      }}
      .sidebar-panel {{
        position: static;
      }}
      .content-actionbar {{
        align-items: flex-start;
        flex-direction: column;
      }}
      .segmented {{
        width: 100%;
      }}
      .result-section-head {{
        align-items: flex-start;
        flex-direction: column;
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

    <section class="workspace-layout">
      <aside class="sidebar-panel" aria-label="筛选">
        <div class="sidebar-head">
          <div>
            <p class="eyebrow">筛选</p>
            <strong>报表范围</strong>
          </div>
          <button id="sidebarToggle" class="icon-button" type="button" aria-expanded="true" aria-label="收起筛选">&lt;</button>
        </div>

        <div class="sidebar-body">
          <div class="sidebar-section">
            <p class="eyebrow">视图</p>
            <div class="segmented" role="tablist" aria-label="视图切换">
              <button id="studentTab" type="button" class="active" data-view="student">学生收费</button>
              <button id="teacherTab" type="button" data-view="teacher">老师收入</button>
            </div>
          </div>

          <div class="filter-grid">
            <div class="field">
              <label for="monthSearch">月份</label>
              <input id="monthSearch" class="picker-search" type="text" placeholder="搜索月份" autocomplete="off" />
              <div id="monthOptions" class="picker-options" data-filter-list="months"></div>
              <div id="monthChips" class="selection-chips" aria-label="已选月份"></div>
            </div>
            <div class="field">
              <label id="entityLabel" for="entitySearch">学生</label>
              <input id="entitySearch" class="picker-search" type="text" placeholder="搜索学生" autocomplete="off" />
              <div id="entityOptions" class="picker-options" data-filter-list="entities"></div>
              <div id="entityChips" class="selection-chips" aria-label="已选对象"></div>
            </div>
          </div>

          <div class="sidebar-section sidebar-actions">
            <button id="exportButton" class="button primary" type="button">导出当前汇总 CSV</button>
          </div>
        </div>
      </aside>

      <section class="content-panel">
        <div class="content-actionbar">
          <div>
            <p class="eyebrow">当前筛选</p>
            <div class="panel-title" id="groupTitle">汇总</div>
            <div class="panel-subtitle" id="groupSubtitle"></div>
          </div>
          <span class="badge" id="currentIssueBadge">0 个数据提醒</span>
        </div>

        <section class="summary" id="summaryCards"></section>

        <section class="card panel">
          <div id="groupSections" class="result-sections"></div>
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
              <th class="numeric">单价（¥）</th>
              <th class="numeric">时长（h）</th>
              <th class="numeric">原表金额（¥）</th>
              <th class="numeric">规则金额（¥）</th>
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
      selectedMonths: REPORT_DATA.metadata.defaultMonth ? [REPORT_DATA.metadata.defaultMonth] : [],
      selectedEntities: [],
      monthSearch: "",
      entitySearch: "",
      adjustments: {{}},
      sidebarCollapsed: false,
    }};

    const els = {{
      rowStats: document.getElementById("rowStats"),
      workspaceLayout: document.querySelector(".workspace-layout"),
      sidebarToggle: document.getElementById("sidebarToggle"),
      monthSearch: document.getElementById("monthSearch"),
      monthOptions: document.getElementById("monthOptions"),
      monthChips: document.getElementById("monthChips"),
      entitySearch: document.getElementById("entitySearch"),
      entityOptions: document.getElementById("entityOptions"),
      entityChips: document.getElementById("entityChips"),
      entityLabel: document.getElementById("entityLabel"),
      studentTab: document.getElementById("studentTab"),
      teacherTab: document.getElementById("teacherTab"),
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
    }};

    function money(value) {{
      return new Intl.NumberFormat("zh-CN", {{ style: "currency", currency: "CNY", maximumFractionDigits: 2 }}).format(value || 0);
    }}

    function moneyValue(value) {{
      return new Intl.NumberFormat("zh-CN", {{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}).format(value || 0);
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

    function selectedMonths() {{
      return REPORT_DATA.months.filter((month) => state.selectedMonths.includes(month));
    }}

    function entityOptionsForSelectedMonths() {{
      const byName = new Map();
      for (const month of selectedMonths()) {{
        for (const option of REPORT_DATA.entityOptions[state.view]?.[month] || []) {{
          const current = byName.get(option.name) || {{ name: option.name, amount: 0, duration: 0, lessons: 0, cancelledLessons: 0 }};
          current.amount += option.amount || 0;
          current.duration += option.duration || 0;
          current.lessons += option.lessons || 0;
          current.cancelledLessons += option.cancelledLessons || 0;
          byName.set(option.name, current);
        }}
      }}
      return [...byName.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"));
    }}

    function selectedEntityOptions() {{
      const options = entityOptionsForSelectedMonths();
      return options.filter((option) => state.selectedEntities.includes(option.name));
    }}

    function currentResults() {{
      const results = [];
      for (const entity of state.selectedEntities) {{
        for (const month of selectedMonths()) {{
          const result = REPORT_DATA.views[state.view]?.[month]?.[entity];
          if (result) results.push(result);
        }}
      }}
      return results;
    }}

    function combinedTotals(results) {{
      return results.reduce((totals, result) => ({{
        lessons: totals.lessons + result.totals.lessons,
        duration: totals.duration + result.totals.duration,
        amount: totals.amount + result.totals.amount,
        cancelledLessons: totals.cancelledLessons + result.totals.cancelledLessons,
        cancelledDuration: totals.cancelledDuration + result.totals.cancelledDuration,
        cancelledAmount: totals.cancelledAmount + result.totals.cancelledAmount,
        issueCount: totals.issueCount + result.totals.issueCount,
      }}), {{
        lessons: 0,
        duration: 0,
        amount: 0,
        cancelledLessons: 0,
        cancelledDuration: 0,
        cancelledAmount: 0,
        issueCount: 0,
      }});
    }}

    function groupAdjustmentKey(result, group) {{
      return JSON.stringify([
        result.view,
        result.month,
        result.entity,
        group.counterparty,
        group.courseType,
        group.teachingType,
        group.cancellationStatus,
      ]);
    }}

    function getAdjustment(key) {{
      if (!state.adjustments[key]) {{
        state.adjustments[key] = {{ discountPercent: "100", reason: "" }};
      }}
      return state.adjustments[key];
    }}

    function actualAmount(amount, discountPercent) {{
      const discount = Number(discountPercent);
      return (amount || 0) * (Number.isFinite(discount) ? discount : 0) / 100;
    }}

    function renderSidebarState() {{
      els.workspaceLayout.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
      els.sidebarToggle.textContent = state.sidebarCollapsed ? ">" : "<";
      els.sidebarToggle.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
      els.sidebarToggle.setAttribute("aria-label", state.sidebarCollapsed ? "展开筛选" : "收起筛选");
    }}

    function ensureValidSelections() {{
      state.selectedMonths = state.selectedMonths.filter((month) => REPORT_DATA.months.includes(month));
      if (!state.selectedMonths.length && REPORT_DATA.months.length) {{
        state.selectedMonths = [REPORT_DATA.metadata.defaultMonth || REPORT_DATA.months.at(-1)];
      }}

      const options = entityOptionsForSelectedMonths();
      const optionNames = new Set(options.map((option) => option.name));
      state.selectedEntities = state.selectedEntities.filter((entity) => optionNames.has(entity));
      if (!state.selectedEntities.length && options.length) {{
        state.selectedEntities = [options[0].name];
      }}
    }}

    function renderMonthOptions() {{
      const search = state.monthSearch.trim().toLowerCase();
      const months = REPORT_DATA.months.filter((month) => month.toLowerCase().includes(search));
      els.monthOptions.innerHTML = months.length ? months.map((month) => `
        <label class="picker-option">
          <input type="checkbox" value="${{escapeHtml(month)}}" ${{state.selectedMonths.includes(month) ? "checked" : ""}} data-month-option />
          <span>${{escapeHtml(month)}}</span>
        </label>
      `).join("") : `<div class="empty">没有匹配月份</div>`;

      els.monthOptions.querySelectorAll("[data-month-option]").forEach((input) => {{
        input.addEventListener("change", () => {{
          if (input.checked) {{
            state.selectedMonths = [...new Set([...state.selectedMonths, input.value])].sort();
          }} else {{
            state.selectedMonths = state.selectedMonths.filter((month) => month !== input.value);
          }}
          ensureValidSelections();
          render();
        }});
      }});
    }}

    function renderEntityOptions() {{
      const options = entityOptionsForSelectedMonths();
      const search = state.entitySearch.trim().toLowerCase();
      const visibleOptions = options.filter((option) => option.name.toLowerCase().includes(search));
      const entityName = state.view === "student" ? "学生" : "老师";
      els.entityLabel.textContent = entityName;
      els.entitySearch.placeholder = `搜索${{entityName}}`;
      els.entityOptions.innerHTML = visibleOptions.length ? visibleOptions.map((option) => {{
        const summary = `${{option.name}} · ${{money(option.amount)}} · ${{number(option.duration)}}h`;
        return `
          <label class="picker-option">
            <input type="checkbox" value="${{escapeHtml(option.name)}}" ${{state.selectedEntities.includes(option.name) ? "checked" : ""}} data-entity-option />
            <span>${{escapeHtml(summary)}}</span>
          </label>
        `;
      }}).join("") : `<div class="empty">没有匹配${{escapeHtml(entityName)}}</div>`;

      els.entityOptions.querySelectorAll("[data-entity-option]").forEach((input) => {{
        input.addEventListener("change", () => {{
          if (input.checked) {{
            state.selectedEntities = [...new Set([...state.selectedEntities, input.value])];
          }} else {{
            state.selectedEntities = state.selectedEntities.filter((entity) => entity !== input.value);
          }}
          render();
        }});
      }});
    }}

    function renderSelectionChips() {{
      const entityName = state.view === "student" ? "学生" : "老师";
      els.monthChips.innerHTML = state.selectedMonths.length ? state.selectedMonths.map((month) => `
        <span class="selection-chip">
          <span>${{escapeHtml(month)}}</span>
          <button type="button" data-chip-type="month" data-chip-value="${{escapeHtml(month)}}" aria-label="移除月份 ${{escapeHtml(month)}}">x</button>
        </span>
      `).join("") : `<span class="selection-empty">未选择月份</span>`;

      els.entityChips.innerHTML = state.selectedEntities.length ? state.selectedEntities.map((entity) => `
        <span class="selection-chip">
          <span>${{escapeHtml(entity)}}</span>
          <button type="button" data-chip-type="entity" data-chip-value="${{escapeHtml(entity)}}" aria-label="移除${{escapeHtml(entityName)}} ${{escapeHtml(entity)}}">x</button>
        </span>
      `).join("") : `<span class="selection-empty">未选择${{escapeHtml(entityName)}}</span>`;

      [...els.monthChips.querySelectorAll("[data-chip-type]"), ...els.entityChips.querySelectorAll("[data-chip-type]")].forEach((button) => {{
        button.addEventListener("click", () => {{
          if (button.dataset.chipType === "month") {{
            state.selectedMonths = state.selectedMonths.filter((month) => month !== button.dataset.chipValue);
            ensureValidSelections();
          }} else {{
            state.selectedEntities = state.selectedEntities.filter((entity) => entity !== button.dataset.chipValue);
          }}
          render();
        }});
      }});
    }}

    function renderSummary(results) {{
      const totals = combinedTotals(results);
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

    function renderGroups(results) {{
      const totals = combinedTotals(results);
      const entityName = state.view === "student" ? "学生" : "老师";
      const selectedEntities = selectedEntityOptions();
      els.groupTitle.textContent = results.length === 1
        ? `${{results[0].subjectLabel}}：${{results[0].entity}}`
        : `${{entityName}}：${{selectedEntities.length}} 个`;
      els.groupSubtitle.textContent = `${{selectedMonths().join("、") || "未选择月份"}} · 金额来自原表“课程总价格”，规则金额用于校验`;
      els.currentIssueBadge.textContent = `${{number(totals.issueCount)}} 个数据提醒`;
      els.currentIssueBadge.className = `badge ${{totals.issueCount ? "warn" : ""}}`;

      if (!results.length || !results.some((result) => result.groups.length)) {{
        els.groupSections.innerHTML = `<div class="empty">当前筛选没有可计费课程</div>`;
        return;
      }}

      els.groupSections.innerHTML = results.map((result, resultIndex) => `
        <section class="result-section">
          <div class="result-section-head">
            <div>
              <div class="result-section-title">${{escapeHtml(result.subjectLabel)}}：${{escapeHtml(result.entity)}}</div>
              <div class="result-section-meta">${{escapeHtml(result.month)}} · ${{number(result.totals.lessons)}} 课 · ${{money(result.totals.amount)}}</div>
            </div>
            ${{result.totals.issueCount ? `<span class="badge warn">${{number(result.totals.issueCount)}} 个数据提醒</span>` : ""}}
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
                  <th>${{escapeHtml(result.counterpartyLabel)}}</th>
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
                ${{result.groups.map((group, groupIndex) => {{
                  const adjustment = getAdjustment(groupAdjustmentKey(result, group));
                  return `
                    <tr>
                      <td><strong>${{escapeHtml(group.counterparty)}}</strong></td>
                      <td>${{escapeHtml(group.courseType)}}</td>
                      <td>${{escapeHtml(group.teachingType)}}</td>
                      <td>${{statusBadge(group.cancellationStatus)}}</td>
                      <td class="numeric">${{number(group.lessons)}}</td>
                      <td class="numeric">${{number(group.duration)}}</td>
                      <td class="numeric">${{number(group.cancelledDuration)}}</td>
                      <td class="numeric">${{escapeHtml(group.unitPriceLabel)}}</td>
                      <td class="numeric">
                        <input class="table-input number-input" type="number" step="0.01" value="${{escapeHtml(adjustment.discountPercent)}}" data-discount-input data-result-index="${{resultIndex}}" data-group-index="${{groupIndex}}" aria-label="折扣百分比" />
                      </td>
                      <td>
                        <input class="table-input reason-input" type="text" value="${{escapeHtml(adjustment.reason)}}" data-discount-reason data-result-index="${{resultIndex}}" data-group-index="${{groupIndex}}" aria-label="折扣原因" />
                      </td>
                      <td class="numeric"><strong>${{moneyValue(group.amount)}}</strong></td>
                      <td class="numeric"><strong data-actual-amount="${{resultIndex}}-${{groupIndex}}">${{moneyValue(actualAmount(group.amount, adjustment.discountPercent))}}</strong></td>
                      <td>
                        <button class="link-button" type="button" data-detail-result-index="${{resultIndex}}" data-detail-group-index="${{groupIndex}}">${{group.rawRows.length}} 行明细</button>
                        ${{group.issueCount ? `<span class="badge warn">${{group.issueCount}} 提醒</span>` : ""}}
                      </td>
                    </tr>
                  `;
                }}).join("")}}
              </tbody>
            </table>
          </div>
        </section>
      `).join("");

      els.groupSections.querySelectorAll("[data-detail-result-index]").forEach((button) => {{
        button.addEventListener("click", () => {{
          const result = results[Number(button.dataset.detailResultIndex)];
          const group = result.groups[Number(button.dataset.detailGroupIndex)];
          openDrawer(group.rawRows, `${{result.entity}} · ${{group.counterparty}} · ${{group.courseType}}`, `${{result.month}} · ${{group.teachingType}} · ${{group.cancellationStatus}}`);
        }});
      }});
      els.groupSections.querySelectorAll("[data-discount-input]").forEach((input) => {{
        input.addEventListener("input", () => {{
          const result = results[Number(input.dataset.resultIndex)];
          const group = result.groups[Number(input.dataset.groupIndex)];
          const adjustment = getAdjustment(groupAdjustmentKey(result, group));
          adjustment.discountPercent = input.value;
          const actual = els.groupSections.querySelector(`[data-actual-amount="${{input.dataset.resultIndex}}-${{input.dataset.groupIndex}}"]`);
          if (actual) actual.textContent = moneyValue(actualAmount(group.amount, adjustment.discountPercent));
        }});
      }});
      els.groupSections.querySelectorAll("[data-discount-reason]").forEach((input) => {{
        input.addEventListener("input", () => {{
          const result = results[Number(input.dataset.resultIndex)];
          const group = result.groups[Number(input.dataset.groupIndex)];
          getAdjustment(groupAdjustmentKey(result, group)).reason = input.value;
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

    function renderIssues(results) {{
      const issues = results.flatMap((result) => result.qualityIssues);
      els.issueSubtitle.textContent = `${{selectedMonths().join("、") || "未选择月份"}} · ${{state.selectedEntities.join("、") || "未选择"}}`;
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
          <td class="numeric">${{record.unitPrice == null ? "缺失" : moneyValue(record.unitPrice)}}</td>
          <td class="numeric">${{number(record.duration)}}</td>
          <td class="numeric">${{moneyValue(record.sourceAmount)}}</td>
          <td class="numeric">${{record.expectedAmount == null ? "未配置" : moneyValue(record.expectedAmount)}}</td>
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
      const results = currentResults();
      if (!results.length) return;
      const rows = [[`${{results[0].subjectLabel}}名`, "月份", results[0]?.counterpartyLabel || "", "课程类型", "授课类型", "取消/上课状态", "课程数", "总时长（h）", "取消时长（h）", "课程单价（¥）", "折扣（%）", "折扣原因", "总金额（¥）", "实际金额（¥）", "原始行"]];
      results.forEach((result) => {{
        result.groups.forEach((group) => {{
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
        }});
      }});
      const csv = rows.map((row) => row.map((cell) => `"${{String(cell).replaceAll('"', '""')}}"`).join(",")).join("\\n");
      const blob = new Blob(["\\ufeff", csv], {{ type: "text/csv;charset=utf-8" }});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${{state.view}}-${{selectedMonths().join("+")}}-${{state.selectedEntities.join("+")}}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    }}

    function render() {{
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
    }}

    els.studentTab.addEventListener("click", () => {{
      state.view = "student";
      state.selectedEntities = [];
      state.entitySearch = "";
      els.entitySearch.value = "";
      render();
    }});
    els.teacherTab.addEventListener("click", () => {{
      state.view = "teacher";
      state.selectedEntities = [];
      state.entitySearch = "";
      els.entitySearch.value = "";
      render();
    }});
    els.monthSearch.addEventListener("input", (event) => {{
      state.monthSearch = event.target.value;
      renderMonthOptions();
    }});
    els.entitySearch.addEventListener("input", (event) => {{
      state.entitySearch = event.target.value;
      renderEntityOptions();
    }});
    els.sidebarToggle.addEventListener("click", () => {{
      state.sidebarCollapsed = !state.sidebarCollapsed;
      renderSidebarState();
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
