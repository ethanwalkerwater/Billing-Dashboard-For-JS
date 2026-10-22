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
import re
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
    canonical_identity,
    finalize_teacher_score_rows,
    generate_monthly_feedback_report,
    load_name_map,
    normalize_student,
    normalize_teacher,
    normalize_text,
    parse_datetime,
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


# ---- 4 分算 5 分（业务方 2026-10 定，只用于 LIVE_SCORES_FROM 起实时计算的月份）----
# 规则 1「连续打 4 分」：同一评价人（学生或家长）给同一老师的同一项，前 3 个月都是 4 分、每个月都有这位老师的课，
#   本月仍有课又打 4 分 → 本月这一项按 5 分算。前 3 个月看原始分，所以一直打 4 分的人之后每个月都继续算 5 分。
# 规则 2「评分标准高」：本月给 2 位及以上老师打过分，所有老师所有项都没打过 5 分 → 他的 4 分都按 5 分算，4 分以下不变。
# 明细里存的始终是原始分，另外记下哪几项被改了（adjusted），下个月判断规则 1 要用原始分。
ADJUST_DIMS = ("charisma", "learning_effect", "responsibility")
ADJUST_ROLES = ("student", "parent")
STREAK_MONTHS = 3


def student_key(name: str, aliases: Dict[str, str]) -> str:
    text = nfkc(name or "").strip()
    text = aliases.get(text.lower(), text)
    return re.sub(r"\s+", "", re.sub(r"\d+$", "", text)).lower()


def is_matched(value: object) -> bool:
    return str(value) in ("1", "True", "true")


def score_adjustments(rows: List[Dict[str, object]], prior: List[List[Dict[str, object]]], aliases: List[Dict[str, str]]) -> Dict[int, Dict[str, str]]:
    """返回 行号 → {分数字段: "streak" | "strict-rater"}；prior 是前 3 个月（由远到近）存下的明细。"""
    student_aliases = {nfkc(a.get("alias", "")).strip().lower(): nfkc(a.get("canonical", "")) for a in aliases if a.get("kind") == "student"}
    skey = lambda name: student_key(str(name or ""), student_aliases)  # noqa: E731

    history: Dict[tuple, tuple] = {}
    if len(prior) == STREAK_MONTHS:
        for month_index, month_rows in enumerate(prior):
            for row in month_rows:
                for field, value in (row.get("scores") or {}).items():
                    history[(month_index, skey(row.get("student")), teacher_key(str(row.get("teacher") or "")), field)] = (value, bool(row.get("matched")))

    rated: Dict[tuple, Dict[str, object]] = {}
    for row in rows:
        for role in ADJUST_ROLES:
            values = [number(row.get(f"score_{dim}_{role}")) for dim in ADJUST_DIMS]
            values = [value for value in values if value is not None]
            if values:
                entry = rated.setdefault((skey(row["student"]), role), {"teachers": set(), "max": 0.0})
                entry["teachers"].add(teacher_key(str(row["teacher"])))
                entry["max"] = max(entry["max"], *values)
    strict_raters = {key for key, entry in rated.items() if len(entry["teachers"]) >= 2 and entry["max"] == 4}

    adjustments: Dict[int, Dict[str, str]] = {}
    for index, row in enumerate(rows):
        student, teacher = skey(row["student"]), teacher_key(str(row["teacher"]))
        for role in ADJUST_ROLES:
            for dim in ADJUST_DIMS:
                field = f"{dim}_{role}"
                if number(row.get(f"score_{field}")) != 4:
                    continue
                prev = [history.get((month_index, student, teacher, field)) for month_index in range(STREAK_MONTHS)]
                if is_matched(row.get("matched")) and all(p and p[0] == 4 and p[1] for p in prev):
                    adjustments.setdefault(index, {})[field] = "streak"
                elif (student, role) in strict_raters:
                    adjustments.setdefault(index, {})[field] = "strict-rater"
    return adjustments


def detail(rows: List[Dict[str, object]], show, adjustments: Optional[Dict[int, Dict[str, str]]] = None) -> List[Dict[str, object]]:
    adjustments = adjustments or {}
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
            **({"adjusted": adjustments[index]} if index in adjustments else {}),
        }
        for index, row in enumerate(rows)
    ]


# ---- 课堂体验（官网「上课风格 / 教学节奏 / 课堂互动」）----
# 和评分同一套课时权重：同一学生-老师一个月算一份（学生、家长都填了取平均），权重 = 学生当月跟这位老师的课时。
# 存「偏右侧选择 × 课时」的和、课时和、份数，累计时逐月相加，位置 = 加权和 ÷ 课时和 × 100。
# 按选项开头的类型名认：快照里多选题用「、」连接，选项说明里本身也有「、」，不能按分隔符拆。
PREFERENCE_AXES = {
    "classStyle": ("上课风格", "风趣幽默型", "严谨专注型"),
    "teachingPace": ("教学节奏", "高效紧凑型", "稳扎稳打型"),
    "classroomInteraction": ("课堂互动", "系统讲授型", "互动引导型"),
}


def preference_choice(text: str, left: str, right: str) -> Optional[float]:
    """0 = 左侧，1 = 右侧；多选题两边都选算 0.5；「其他」或没填返回 None。"""
    has_left, has_right = left in text, right in text
    if has_left and has_right:
        return 0.5
    if has_left or has_right:
        return 1.0 if has_right else 0.0
    return None


def preferences(feedback_csv: Path, name_map: Path, detail_rows: List[Dict[str, object]], dedupe_keep: str, show) -> Dict[str, Dict[str, Dict[str, float]]]:
    maps = load_name_map(name_map)
    hours = {(row["teacher"], row["student"]): float(row["student_teacher_hours"]) for row in detail_rows if is_matched(row.get("matched"))}
    # 和评分脚本一样，同一老师 + 学生 + 身份只留一份（first / last）
    latest: Dict[tuple, tuple] = {}
    with feedback_csv.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            teacher = normalize_teacher(row.get("老师姓名", ""), maps["teacher"])
            student = normalize_student(row.get("学生姓名", ""), maps["student"])
            submitted = parse_datetime(row.get("提交时间", ""))
            if (teacher, student) not in hours or submitted is None:
                continue
            key = (teacher, student, canonical_identity(row.get("身份", "")))
            current = latest.get(key)
            if current is None or (submitted < current[0] if dedupe_keep == "first" else submitted > current[0]):
                latest[key] = (submitted, row)

    choices: Dict[tuple, Dict[str, List[float]]] = {}
    for (teacher, student, _), (_, row) in latest.items():
        for axis, (column, left, right) in PREFERENCE_AXES.items():
            choice = preference_choice(row.get(column) or "", left, right)
            if choice is not None:
                choices.setdefault((teacher, student), {}).setdefault(axis, []).append(choice)

    result: Dict[str, Dict[str, Dict[str, float]]] = {}
    for (teacher, student), axes in choices.items():
        weight = hours[(teacher, student)]
        for axis, values in axes.items():
            item = result.setdefault(show(teacher), {}).setdefault(axis, {"weighted": 0.0, "hours": 0.0, "responses": 0})
            item["weighted"] += weight * sum(values) / len(values)
            item["hours"] += weight
            item["responses"] += len(values)
    for axes in result.values():
        for item in axes.values():
            item["weighted"], item["hours"] = round(item["weighted"], 6), round(item["hours"], 6)
    return result


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


def rescore_with_adjustments(course_month: str, folder: Path, rows: List[Dict[str, object]], adjustments: Dict[int, Dict[str, str]]) -> List[Dict[str, object]]:
    """把被改的 4 分换成 5 分，用同一套加权（按明细重算）再算一遍。"""
    changed = []
    for index, row in enumerate(rows):
        row = dict(row)
        for field in adjustments.get(index, {}):
            row[f"score_{field}"] = 5
        changed.append(row)
    fieldnames = list(dict.fromkeys(key for row in changed for key in row))
    with (folder / "adjusted_detail.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(changed)
    return rebuild_historical_result_from_detail(
        report_month=course_month,
        detail_path=folder / "adjusted_detail.csv",
        schedule_csv=folder / "schedule.csv",
        name_map_csv=folder / "name_map.csv",
        include_cancelled=False,
        max_duration_hours=8.0,
        exclude_course_type_keywords=COURSE_TYPE_EXCLUDES,
        excluded_teachers=set(),
    )["summary_rows"]


def compute_month(event: Dict[str, object]) -> Dict[str, object]:
    course_month = str(event["courseMonth"])
    display = {teacher_key(name): name for name in event.get("teacherNames") or []}
    show = lambda name: display.get(teacher_key(name), name)  # noqa: E731

    adjustments: Dict[int, Dict[str, str]] = {}
    adjusted_summary: List[Dict[str, object]] = []
    prefs: Dict[str, Dict[str, Dict[str, float]]] = {}
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
                # 答卷快照已经按「反馈课程月份」筛好了这一轮（月中提前交的也在里面），
                # 不能再让脚本按「提交月 = 课程月 + 1」筛一遍，所以给一个包住所有提交时间的窗口。
                feedback_start_date="2000-01-01",
                feedback_end_date="2999-12-31",
            )
            summary_rows, detail_rows = result["summary_rows"], result["detail_rows"]
            prefs = preferences(folder / "feedback.csv", name_map, detail_rows, str(event.get("dedupeKeep") or "last"), show)
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
            if not event.get("history"):
                adjustments = score_adjustments(detail_rows, event.get("priorDetails") or [], event.get("aliases") or [])
                if adjustments:
                    adjusted_summary = rescore_with_adjustments(course_month, folder, detail_rows, adjustments)
                    stats["adjustedScores"] = {
                        rule: sum(1 for fields in adjustments.values() for value in fields.values() if value == rule)
                        for rule in ("streak", "strict-rater")
                    }

    for row in summary_rows:
        row["teacher"] = show(row["teacher"])
    teachers = compact_teachers(summary_rows)
    if adjusted_summary:
        # 课时、份数、覆盖率沿用原始结果；只换分数（4 分改 5 分后重新加权）
        for row in adjusted_summary:
            row["teacher"] = show(row["teacher"])
        rescored = {row["teacher"]: row for row in compact_teachers(adjusted_summary)}
        for teacher in teachers:
            if teacher["teacher"] in rescored:
                for key in ("scores", "variants", "counts"):
                    teacher[key] = rescored[teacher["teacher"]][key]
    teachers = with_rank(teachers)
    if event.get("history"):
        teachers = overlay_history(teachers, event["history"], show)
    return {"teachers": teachers, "stats": stats, "detail": detail(detail_rows, show, adjustments), "preferences": prefs}


def main(event, context=None):
    try:
        return {"ok": True, **compute_month(event or {})}
    except SystemExit as error:
        # 例如月初还没有反馈：返回原因，页面显示「还算不出分数」。
        return {"ok": False, "error": str(error)}
