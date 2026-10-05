"""
feedback-score —— 老师加权评分计算云函数。

只做纯计算：输入课表/答卷 CSV 文本、历史月度分数、姓名别名和不统计老师，返回月度与累计评分。
不读数据库、不碰任何密钥，所以谁调都只能算自己给的数据；由 feedback-api 读库后调用。

算法本身不在这里：直接复用 apps/teacher-feedback/scripts 里的月度/累计脚本（打包时复制进来），
保证和老看板口径完全一致，那边的 41 个测试继续有效。
"""
from __future__ import annotations

import csv
import io
import tempfile
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional

from cumulative_teacher_feedback import aggregate_monthly_summaries
from monthly_teacher_feedback import (
    METRIC_VIEWS,
    NO_SCORE_LABEL,
    NUMERIC_SCORE_FIELDS,
    TEACHER_SCORE_EXPORT_METRICS,
    TEXT_FEEDBACK_FIELDS,
    finalize_teacher_score_rows,
    generate_monthly_feedback_report,
    normalize_text,
)

SCORE_METRICS = [metric_id for metric_id, _ in TEACHER_SCORE_EXPORT_METRICS]
LABEL_OF = dict(TEACHER_SCORE_EXPORT_METRICS)


def nfkc(text: str) -> str:
    """全角转半角：与问卷跟踪的姓名规范化一致，「邓老师（地理）」和「邓老师(地理)」是同一个人。"""
    return unicodedata.normalize("NFKC", text or "")


NAME_COLUMNS = ("老师", "学生", "老师姓名", "学生姓名")


def normalize_name_columns(text: str) -> str:
    """只把姓名列全角转半角。整份 CSV 做 NFKC 会把答案里的全角逗号变成真逗号，列就错位了。"""
    rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff"))))
    if not rows:
        return text
    targets = [index for index, name in enumerate(rows[0]) if name in NAME_COLUMNS]
    for row in rows[1:]:
        for index in targets:
            if index < len(row):
                row[index] = nfkc(row[index])
    out = io.StringIO()
    csv.writer(out).writerows(rows)
    return out.getvalue()


def teacher_key(name: str) -> str:
    """和评分脚本的老师归一化一致：去空白、去「老师」后缀；再全角转半角、忽略大小写。"""
    text = normalize_text(nfkc(name))
    if text.endswith("老师"):
        text = text[:-2]
    return text.lower()


def number(value: object) -> Optional[float]:
    if value in ("", None, NO_SCORE_LABEL):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def ranked(rows: List[Dict[str, object]]) -> Dict[str, Dict[str, object]]:
    """沿用脚本的三项平均、三位小数四舍五入和并列排名。返回 老师 → {rank, overall, scores}。"""
    table = finalize_teacher_score_rows(
        [{"老师": row["teacher"], **{LABEL_OF[m]: row["scores"].get(m) if row["scores"].get(m) is not None else "" for m in SCORE_METRICS}} for row in rows]
    )
    return {
        str(row["老师"]): {
            "rank": row["排名"] or None,
            "overall": number(row["总评分"]),
            "scores": {m: number(row[LABEL_OF[m]]) for m in SCORE_METRICS},
        }
        for row in table
    }


def write_name_map(path: Path, aliases: List[Dict[str, str]]) -> None:
    # 评分脚本查老师别名前会先去掉「老师」后缀，所以老师别名的原写法也要去掉，否则「马老师」永远查不到。
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["entity", "raw", "normalized"])
        for alias in aliases:
            raw = nfkc(alias.get("alias", ""))
            if alias.get("kind") == "teacher" and normalize_text(raw).endswith("老师"):
                raw = normalize_text(raw)[:-2]
            writer.writerow([alias.get("kind", ""), raw, nfkc(alias.get("canonical", ""))])


def live_month(month: Dict[str, object], workdir: Path, name_map: Path, excluded_raw: str, show) -> Dict[str, object]:
    folder = workdir / str(month["courseMonth"])
    folder.mkdir()
    # 课表、答卷里的姓名先做全角转半角，和别名表、不统计名单的写法对齐。
    (folder / "feedback.csv").write_text(normalize_name_columns(str(month["feedbackCsv"])), encoding="utf-8")
    (folder / "schedule.csv").write_text(normalize_name_columns(str(month["scheduleCsv"])), encoding="utf-8")
    result = generate_monthly_feedback_report(
        month=str(month["courseMonth"]),
        feedback_csv=folder / "feedback.csv",
        schedule_csv=folder / "schedule.csv",
        output_dir=folder / "out",
        name_map_csv=name_map,
        exclude_teachers_raw=excluded_raw,
        dedupe_keep=str(month.get("dedupeKeep") or "last"),
    )
    for row in result["summary_rows"]:
        row["teacher"] = show(row["teacher"])
    for row in result["detail_rows"]:
        row["teacher"] = show(row["teacher"])
    return result


def compact_teachers(summary_rows: List[Dict[str, object]]) -> List[Dict[str, object]]:
    teachers = []
    for row in summary_rows:
        variants: Dict[str, Dict[str, Optional[float]]] = {}
        counts: Dict[str, Dict[str, int]] = {}
        for metric in METRIC_VIEWS:
            variants[metric["id"]] = {}
            counts[metric["id"]] = {}
            for variant in metric["variants"]:
                prefix = f"metric_{metric['id']}_{variant['id']}"
                count = int(float(row.get(f"{prefix}_value_count") or 0))
                counts[metric["id"]][variant["id"]] = count
                variants[metric["id"]][variant["id"]] = number(row.get(f"{prefix}_normalized_avg")) if count > 0 else None
        teachers.append(
            {
                "teacher": row["teacher"],
                "hours": float(row.get("teacher_total_hours") or 0),
                "responses": int(row.get("response_record_count") or 0),
                "matchedResponses": int(row.get("matched_response_record_count") or 0),
                "respondedStudents": int(row.get("responded_student_count") or 0),
                "coverage": float(row.get("coverage_rate") or 0),
                "scores": {m: variants[m]["total"] for m in SCORE_METRICS},
                "variants": variants,
                "counts": counts,
            }
        )
    return teachers


def with_rank(teachers: List[Dict[str, object]]) -> List[Dict[str, object]]:
    ranks = ranked(teachers)
    for teacher in teachers:
        teacher.update(ranks[teacher["teacher"]])
    return sorted(teachers, key=lambda t: (t["rank"] is None, t["rank"] or 0, t["teacher"]))


def history_summary_row(row: Dict[str, object]) -> Dict[str, object]:
    """历史月度分数转成累计脚本认的 teacher_summary 形状。"""
    hours = float(row.get("hours") or 0)
    summary: Dict[str, object] = {
        "teacher": row["teacher"],
        "teacher_total_hours": hours,
        "response_record_count": int(row.get("responses") or 0),
        "matched_response_record_count": int(row.get("matchedResponses") or 0),
        "responded_hours_distinct_students": float(row.get("coverage") or 0) * hours,
    }
    for metric_id in SCORE_METRICS:
        value = (row.get("scores") or {}).get(metric_id)
        summary[f"metric_{metric_id}_total_normalized_avg"] = "" if value is None else value
        summary[f"metric_{metric_id}_total_value_count"] = 0 if value is None else 1
    return summary


def detail(rows: List[Dict[str, object]]) -> List[Dict[str, object]]:
    return [
        {
            "teacher": row["teacher"],
            "student": row["student_raw_name"] or row["student"],
            "identity": row["identity"],
            "sourceIdentities": row["source_identities"],
            "submittedAt": row["submitted_at"],
            "matched": bool(row["matched"]),
            "weight": float(row["normalized_weight"] or 0),
            "scores": {field["id"]: number(row.get(f"score_{field['id']}")) for field in NUMERIC_SCORE_FIELDS},
            "texts": {field["id"]: row.get(f"text_{field['id']}", "") for field in TEXT_FEEDBACK_FIELDS},
        }
        for row in rows
    ]


def build_report(event: Dict[str, object]) -> Dict[str, object]:
    display = {teacher_key(name): name for name in event.get("teacherNames") or []}
    show = lambda name: display.get(teacher_key(name), name)  # noqa: E731
    excluded_keys = {teacher_key(name) for name in event.get("excludedTeachers") or []}
    # 传给脚本的排除名单要和脚本内部的老师名同形（去空白、去「老师」）。
    excluded_raw = ",".join(
        normalize_text(nfkc(name))[:-2] if normalize_text(nfkc(name)).endswith("老师") else normalize_text(nfkc(name))
        for name in event.get("excludedTeachers") or []
    )
    detail_month = event.get("detailMonth")

    monthly: Dict[str, Dict[str, object]] = {}
    cumulative_inputs: Dict[str, List[Dict[str, object]]] = {}

    for item in event.get("history") or []:
        rows = [row for row in item["rows"] if teacher_key(row["teacher"]) not in excluded_keys]
        for row in rows:
            row["teacher"] = show(row["teacher"])
        monthly[item["month"]] = {
            "month": item["month"],
            "source": "history",
            "teachers": with_rank([{**row, "scores": dict(row.get("scores") or {})} for row in rows]),
        }
        cumulative_inputs[item["month"]] = [history_summary_row(row) for row in rows]

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        name_map = workdir / "name_map.csv"
        write_name_map(name_map, event.get("aliases") or [])
        for month in event.get("months") or []:
            course_month = str(month["courseMonth"])
            try:
                result = live_month(month, workdir, name_map, excluded_raw, show)
            except SystemExit as error:
                # 例如月初还没有反馈：只这个月报错，不影响其他月份和累计。
                monthly.setdefault(course_month, {"month": course_month, "source": "live", "teachers": []})
                monthly[course_month]["error"] = str(error)
                continue
            meta = result["run_meta"]
            stats = {
                "feedbackRows": meta["feedback_stats"].get("feedback_rows_in_scope", 0),
                "dedupedRecords": meta["feedback_stats"].get("feedback_latest_record_count", 0),
                "matchedRecords": result["matched_count"],
                "mergedRecords": len(result["detail_rows"]),
                "teacherCount": result["teacher_count"],
                "totalHours": round(result["total_teacher_hours"], 2),
                "unmappedScoreTexts": meta.get("unmapped_score_texts") or {},
                "orgAnalysis": meta.get("org_analysis") or {},
            }
            entry = monthly.get(course_month)
            if entry and entry["source"] == "history":
                # 历史月份分数以定稿为准；重算结果只提供明细和文字评价。
                entry["stats"] = stats
            else:
                monthly[course_month] = {
                    "month": course_month,
                    "source": "live",
                    "teachers": with_rank(compact_teachers(result["summary_rows"])),
                    "stats": stats,
                }
                if month.get("countsTowardCumulative"):
                    cumulative_inputs[course_month] = result["summary_rows"]
            if course_month == detail_month:
                monthly[course_month]["detail"] = detail(result["detail_rows"])

    months = sorted(cumulative_inputs)
    start, end = event.get("cumulativeFrom") or "", event.get("cumulativeTo") or ""
    months = [m for m in months if (not start or m >= start) and (not end or m <= end)]
    summary_rows, score_rows = aggregate_monthly_summaries((m, cumulative_inputs[m]) for m in months)
    scores_by_teacher = {str(row["老师"]): row for row in score_rows}
    cumulative = []
    for row in summary_rows:
        score = scores_by_teacher[str(row["teacher"])]
        cumulative.append(
            {
                "teacher": row["teacher"],
                "rank": score["排名"] or None,
                "overall": number(score["总评分"]),
                "scores": {m: number(score[LABEL_OF[m]]) for m in SCORE_METRICS},
                "hours": row["teacher_total_hours"],
                "monthCount": row["report_month_count"],
                "firstMonth": row["first_report_month"],
                "lastMonth": row["last_report_month"],
                "coverage": row["coverage_rate"],
                "responses": row["response_record_count"],
            }
        )
    cumulative.sort(key=lambda t: (t["rank"] is None, t["rank"] or 0, t["teacher"]))

    contributions = []
    for month in months:
        source = monthly[month]["source"] if month in monthly else "history"
        for row in monthly.get(month, {}).get("teachers", []):
            if row["hours"] > 0:
                contributions.append({"month": month, "teacher": row["teacher"], "hours": row["hours"], "source": source, "scores": row["scores"]})

    return {"monthly": monthly, "cumulative": {"months": months, "teachers": cumulative, "contributions": contributions}}


def main(event, context=None):
    try:
        return {"ok": True, **build_report(event or {})}
    except SystemExit as error:
        return {"ok": False, "error": str(error)}

