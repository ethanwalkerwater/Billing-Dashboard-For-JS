"""
feedback-score —— 老师加权评分计算云函数：一次算一个课程月份。

只做纯计算：输入课表/答卷 CSV 文本和姓名别名，返回这个月每位老师的分数（含学生/家长分项）和逐条明细。
不读数据库、不碰任何密钥，谁调都只能算自己给的数据；由 feedback-api 在数据变了时调用，结果存进
feedback_score_results，页面直接读库，平时不跑这个函数。

算法本身不在这里：直接复用 apps/teacher-feedback/scripts 里的月度脚本（打包时复制进来），
保证和老看板口径完全一致，那边的测试继续有效。累计评分在浏览器里按存好的月度结果加权。
"""
from __future__ import annotations

import csv
import io
import tempfile
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional

from cumulative_teacher_feedback import rebuild_historical_result_from_detail
from monthly_teacher_feedback import (
    METRIC_VIEWS,
    NO_SCORE_LABEL,
    NUMERIC_SCORE_FIELDS,
    TEACHER_SCORE_EXPORT_METRICS,
    TEXT_FEEDBACK_FIELDS,
    finalize_teacher_score_rows,
    generate_monthly_feedback_report,
    load_name_map,
    normalize_teacher,
    normalize_text,
)

# 与评分脚本默认一致的非授课课程类型（课时不计入权重）
COURSE_TYPE_EXCLUDES = ["请假", "假期", "空出", "文书", "会议", "课表确定"]

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
    """沿用脚本的三项平均、三位小数四舍五入和并列排名。返回 老师 → {rank, overall}。"""
    table = finalize_teacher_score_rows(
        [{"老师": row["teacher"], **{LABEL_OF[m]: row["scores"].get(m) if row["scores"].get(m) is not None else "" for m in SCORE_METRICS}} for row in rows]
    )
    return {
        str(row["老师"]): {
            "rank": row["排名"] or None,
            "overall": number(row["总评分"]),
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
    # 只补排名和总评分；各项分数保留原精度，累计评分要按原精度加权，页面显示时再四舍五入到三位。
    ranks = ranked(teachers)
    for teacher in teachers:
        teacher["rank"] = ranks[teacher["teacher"]]["rank"]
        teacher["overall"] = ranks[teacher["teacher"]]["overall"]
    return sorted(teachers, key=lambda t: (t["rank"] is None, t["rank"] or 0, t["teacher"]))


def detail(rows: List[Dict[str, object]], show) -> List[Dict[str, object]]:
    return [
        {
            "teacher": show(str(row["teacher"])),
            "student": row.get("student_raw_name") or row["student"],
            "identity": row.get("identity") or "",
            "sourceIdentities": row.get("source_identities") or "",
            "submittedAt": row.get("submitted_at") or "",
            "matched": str(row.get("matched")) in ("1", "True", "true"),
            "weight": float(row.get("normalized_weight") or 0),
            "scores": {field["id"]: number(row.get(f"score_{field['id']}")) for field in NUMERIC_SCORE_FIELDS},
            "texts": {field["id"]: row.get(f"text_{field['id']}", "") or "" for field in TEXT_FEEDBACK_FIELDS},
        }
        for row in rows
    ]


def overlay_history(teachers: List[Dict[str, object]], history: List[Dict[str, object]], show) -> List[Dict[str, object]]:
    """
    已公布月份：分数、课时、份数、覆盖率以定稿为准（排名据此重排），
    学生/家长分项取自按原始反馈重算的结果——定稿时只公布了总分，分项是补出来的参考。
    """
    recomputed = {teacher_key(row["teacher"]): row for row in teachers}
    rows = []
    for item in history:
        name = show(str(item["teacher"]))
        extra = recomputed.get(teacher_key(name), {})
        rows.append(
            {
                "teacher": name,
                "hours": float(item.get("hours") or 0),
                "responses": int(item.get("responses") or 0),
                "matchedResponses": int(item.get("matchedResponses") or 0),
                "respondedStudents": extra.get("respondedStudents"),
                "coverage": float(item.get("coverage") or 0),
                "scores": dict(item.get("scores") or {}),
                "variants": extra.get("variants"),
                "counts": extra.get("counts"),
            }
        )
    return with_rank(rows)


def compute_month(event: Dict[str, object]) -> Dict[str, object]:
    course_month = str(event["courseMonth"])
    display = {teacher_key(name): name for name in event.get("teacherNames") or []}
    show = lambda name: display.get(teacher_key(name), name)  # noqa: E731

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        name_map = folder / "name_map.csv"
        write_name_map(name_map, event.get("aliases") or [])
        # 课表、答卷里的姓名先做全角转半角，和别名表写法对齐。
        (folder / "schedule.csv").write_text(normalize_name_columns(str(event["scheduleCsv"])), encoding="utf-8")

        if event.get("legacyDetailCsv"):
            # 2026-05 之前：飞书答卷表里已经没有原始答卷，只有老看板留下的逐条明细（已去重、已合并身份）。
            (folder / "detail.csv").write_text(str(event["legacyDetailCsv"]), encoding="utf-8")
            summary_rows = rebuild_historical_result_from_detail(
                report_month=course_month,
                detail_path=folder / "detail.csv",
                schedule_csv=folder / "schedule.csv",
                name_map_csv=name_map,
                include_cancelled=False,
                max_duration_hours=8.0,
                exclude_course_type_keywords=COURSE_TYPE_EXCLUDES,
                excluded_teachers=set(),
            )["summary_rows"]
            teacher_map = load_name_map(name_map)["teacher"]
            with (folder / "detail.csv").open(encoding="utf-8-sig", newline="") as handle:
                detail_rows = [{**row, "teacher": normalize_teacher(row["teacher"], teacher_map)} for row in csv.DictReader(handle)]
            stats = {"mergedRecords": len(detail_rows), "matchedRecords": sum(1 for row in detail_rows if str(row.get("matched")) == "1")}
        else:
            (folder / "feedback.csv").write_text(normalize_name_columns(str(event["feedbackCsv"])), encoding="utf-8")
            result = generate_monthly_feedback_report(
                month=course_month,
                feedback_csv=folder / "feedback.csv",
                schedule_csv=folder / "schedule.csv",
                output_dir=folder / "out",
                name_map_csv=name_map,
                dedupe_keep=str(event.get("dedupeKeep") or "last"),
            )
            summary_rows, detail_rows = result["summary_rows"], result["detail_rows"]
            meta = result["run_meta"]
            stats = {
                "feedbackRows": meta["feedback_stats"].get("feedback_rows_in_scope", 0),
                "dedupedRecords": meta["feedback_stats"].get("feedback_latest_record_count", 0),
                "matchedRecords": result["matched_count"],
                "mergedRecords": len(detail_rows),
                "teacherCount": result["teacher_count"],
                "totalHours": round(result["total_teacher_hours"], 2),
                "unmappedScoreTexts": meta.get("unmapped_score_texts") or {},
            }

    for row in summary_rows:
        row["teacher"] = show(row["teacher"])
    teachers = with_rank(compact_teachers(summary_rows))
    if event.get("history"):
        teachers = overlay_history(teachers, event["history"], show)
    return {"teachers": teachers, "stats": stats, "detail": detail(detail_rows, show)}


def main(event, context=None):
    try:
        return {"ok": True, **compute_month(event or {})}
    except SystemExit as error:
        # 例如月初还没有反馈：返回原因，页面显示「还算不出分数」。
        return {"ok": False, "error": str(error)}
