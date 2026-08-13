#!/usr/bin/env python3
"""Generate a maintainable all-history teacher score table.

Each source feedback month is first converted into its corresponding report
month (the default offset is one month). Monthly scores are calculated by the
existing monthly engine, then combined using each teacher's monthly teaching
hours as weights.
"""

from __future__ import annotations

import argparse
import csv
import json
import tempfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from monthly_teacher_feedback import (
    DEFAULT_FEEDBACK,
    DEFAULT_NAME_MAP,
    DEFAULT_OUTPUT_ROOT,
    DEFAULT_SCHEDULE,
    FeedbackRecord,
    NUMERIC_SCORE_FIELDS,
    TEACHER_SCORE_EXPORT_METRICS,
    apply_weights,
    build_teacher_summary,
    coerce_float,
    filter_excluded_teachers,
    finalize_teacher_score_rows,
    generate_monthly_feedback_report,
    load_name_map,
    parse_datetime,
    parse_month_or_exit,
    parse_name_set,
    read_schedule,
    shift_month,
    write_csv,
)


DEFAULT_CUMULATIVE_OUTPUT_DIR = DEFAULT_OUTPUT_ROOT / "cumulative"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="老师历史累计课时加权评分")
    parser.add_argument("--feedback", default=str(DEFAULT_FEEDBACK), help="反馈 CSV 路径")
    parser.add_argument("--schedule", default=str(DEFAULT_SCHEDULE), help="课表 CSV 路径")
    parser.add_argument("--name-map", default=str(DEFAULT_NAME_MAP), help="姓名映射 CSV")
    parser.add_argument(
        "--feedback-start-month",
        default="",
        help="最早反馈提交月份 YYYY-MM；默认使用文件中的最早月份",
    )
    parser.add_argument(
        "--feedback-end-month",
        default="",
        help="最晚反馈提交月份 YYYY-MM；默认使用文件中的最晚月份",
    )
    parser.add_argument(
        "--feedback-month-offset",
        type=int,
        default=1,
        help="反馈提交月份相对月报月份的偏移，默认 1",
    )
    parser.add_argument("--identities", default="学生,家长/监护人")
    parser.add_argument(
        "--combine-mode",
        choices=["merge_by_student", "independent"],
        default="merge_by_student",
    )
    parser.add_argument("--exclude-teachers", default="")
    parser.add_argument("--include-cancelled", action="store_true")
    parser.add_argument("--max-duration-hours", type=float, default=8.0)
    parser.add_argument(
        "--exclude-course-type-keywords",
        default="请假,假期,空出,文书,会议,课表确定",
    )
    parser.add_argument("--score-map", default="")
    parser.add_argument(
        "--history-root",
        default=str(DEFAULT_OUTPUT_ROOT),
        help="历史月度输出根目录；默认自动接续其中已有的 YYYY-MM 月度汇总",
    )
    parser.add_argument(
        "--ignore-historical-outputs",
        action="store_true",
        help="只使用当前反馈 CSV 可重算的月份，不接续历史月度汇总",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_CUMULATIVE_OUTPUT_DIR),
        help="累计评分输出目录",
    )
    return parser.parse_args()


def discover_feedback_source_months(
    feedback_csv: Path,
    start_month: str = "",
    end_month: str = "",
) -> List[str]:
    if start_month:
        start_month = parse_month_or_exit(start_month)
    if end_month:
        end_month = parse_month_or_exit(end_month)
    if start_month and end_month and start_month > end_month:
        raise SystemExit("反馈月份范围非法：start 必须早于或等于 end")

    months = set()
    with Path(feedback_csv).open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            submitted_at = parse_datetime(row.get("提交时间", ""))
            if submitted_at is None:
                continue
            month = submitted_at.strftime("%Y-%m")
            if start_month and month < start_month:
                continue
            if end_month and month > end_month:
                continue
            months.add(month)
    return sorted(months)


def read_csv_rows(path: Path) -> List[Dict[str, object]]:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def load_historical_monthly_results(
    history_root: Path,
    through_report_month: str,
) -> Dict[str, Dict[str, object]]:
    results: Dict[str, Dict[str, object]] = {}
    history_root = Path(history_root).expanduser().resolve()
    if not history_root.exists():
        return results

    for month_dir in sorted(history_root.iterdir()):
        if not month_dir.is_dir():
            continue
        try:
            report_month = parse_month_or_exit(month_dir.name)
        except SystemExit:
            continue
        if report_month > through_report_month:
            continue
        summary_path = month_dir / "teacher_summary.csv"
        meta_path = month_dir / "run_meta.json"
        if not summary_path.exists() or not meta_path.exists():
            continue

        run_meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if run_meta.get("month") != report_month:
            continue
        results[report_month] = {
            "month": report_month,
            "summary_rows": read_csv_rows(summary_path),
            "source_kind": "historical_monthly_output",
            "source_path": str(summary_path),
        }
    return results


LEGACY_DETAIL_SCORE_COLUMNS = {
    "responsibility_student": "score_responsibility",
    "charisma_student": "score_charisma",
    "recommendation_student": "score_recommendation",
}


def feedback_record_from_detail_row(row: Dict[str, object]) -> FeedbackRecord:
    scores: Dict[str, Optional[float]] = {}
    for field in NUMERIC_SCORE_FIELDS:
        score_id = field["id"]
        value = row.get(f"score_{score_id}")
        if value in ("", None):
            value = row.get(LEGACY_DETAIL_SCORE_COLUMNS.get(score_id, ""))
        scores[score_id] = coerce_float(value)
    return FeedbackRecord(
        teacher=str(row.get("teacher") or ""),
        student=str(row.get("student") or ""),
        student_raw_name=str(row.get("student_raw_name") or row.get("student") or ""),
        identity=str(row.get("identity") or "合并"),
        source_identities=str(row.get("source_identities") or row.get("identity") or ""),
        submitted_at=str(row.get("submitted_at") or ""),
        scores=scores,
    )


def rebuild_historical_result_from_detail(
    *,
    report_month: str,
    detail_path: Path,
    schedule_csv: Path,
    name_map_csv: Path,
    include_cancelled: bool,
    max_duration_hours: float,
    exclude_course_type_keywords: List[str],
    excluded_teachers: set,
) -> Dict[str, object]:
    name_map = load_name_map(name_map_csv)
    (
        teacher_total_hours,
        teacher_student_hours,
        student_total_hours,
        _,
    ) = read_schedule(
        schedule_csv=schedule_csv,
        month=report_month,
        include_cancelled=include_cancelled,
        max_duration_hours=max_duration_hours,
        exclude_course_type_keywords=exclude_course_type_keywords,
        teacher_map=name_map["teacher"],
        student_map=name_map["student"],
    )
    detail_rows = read_csv_rows(detail_path)
    feedback_records = [
        feedback_record_from_detail_row(row)
        for row in detail_rows
        if row.get("teacher") and row.get("student")
    ]
    raw_feedback_records = [
        {
            "teacher": record.teacher,
            "student": record.student,
            "identity": record.identity,
        }
        for record in feedback_records
    ]
    filtered = filter_excluded_teachers(
        records=feedback_records,
        teacher_total_hours=teacher_total_hours,
        teacher_student_hours=teacher_student_hours,
        raw_feedback_records=raw_feedback_records,
        excluded_teachers=excluded_teachers,
    )
    feedback_records = filtered["records"]
    teacher_total_hours = filtered["teacher_total_hours"]
    teacher_student_hours = filtered["teacher_student_hours"]
    raw_feedback_records = filtered["raw_feedback_records"]
    apply_weights(
        records=feedback_records,
        teacher_total_hours=teacher_total_hours,
        teacher_student_hours=teacher_student_hours,
        student_total_hours=student_total_hours,
    )
    return {
        "month": report_month,
        "summary_rows": build_teacher_summary(
            records=feedback_records,
            teacher_total_hours=teacher_total_hours,
            teacher_student_hours=teacher_student_hours,
            raw_feedback_records=raw_feedback_records,
        ),
        "source_kind": "historical_detail_recalculation",
        "source_path": str(detail_path),
    }


def aggregate_monthly_summaries(
    monthly_summaries: Iterable[Tuple[str, List[Dict[str, object]]]],
) -> Tuple[List[Dict[str, object]], List[Dict[str, object]]]:
    accumulators: Dict[str, Dict[str, object]] = {}

    for report_month, summary_rows in monthly_summaries:
        for row in summary_rows:
            teacher = str(row["teacher"])
            teacher_hours = float(row.get("teacher_total_hours") or 0)
            if teacher_hours <= 0:
                continue

            if teacher not in accumulators:
                accumulators[teacher] = {
                    "teacher": teacher,
                    "months": [],
                    "total_hours": 0.0,
                    "responded_hours": 0.0,
                    "response_record_count": 0,
                    "matched_response_record_count": 0,
                    "metric_numerators": defaultdict(float),
                    "metric_hours": defaultdict(float),
                    "metric_month_counts": defaultdict(int),
                }
            item = accumulators[teacher]
            item["months"].append(report_month)
            item["total_hours"] += teacher_hours
            item["responded_hours"] += float(
                row.get("responded_hours_distinct_students") or 0
            )
            item["response_record_count"] += int(row.get("response_record_count") or 0)
            item["matched_response_record_count"] += int(
                row.get("matched_response_record_count") or 0
            )

            for metric_id, _ in TEACHER_SCORE_EXPORT_METRICS:
                value = row.get(f"metric_{metric_id}_total_normalized_avg")
                if value in ("", None):
                    continue
                item["metric_numerators"][metric_id] += float(value) * teacher_hours
                item["metric_hours"][metric_id] += teacher_hours
                item["metric_month_counts"][metric_id] += 1

    summary_rows: List[Dict[str, object]] = []
    score_rows: List[Dict[str, object]] = []
    for teacher in sorted(accumulators):
        item = accumulators[teacher]
        months = sorted(set(item["months"]))
        total_hours = float(item["total_hours"])
        summary: Dict[str, object] = {
            "teacher": teacher,
            "first_report_month": months[0],
            "last_report_month": months[-1],
            "report_month_count": len(months),
            "teacher_total_hours": round(total_hours, 6),
            "response_record_count": item["response_record_count"],
            "matched_response_record_count": item["matched_response_record_count"],
            "responded_student_hours": round(float(item["responded_hours"]), 6),
            "coverage_rate": (
                round(float(item["responded_hours"]) / total_hours, 6)
                if total_hours > 0
                else 0
            ),
        }
        score: Dict[str, object] = {"老师": teacher}

        for metric_id, label in TEACHER_SCORE_EXPORT_METRICS:
            scored_hours = float(item["metric_hours"].get(metric_id, 0))
            weighted_score: Optional[float] = (
                float(item["metric_numerators"][metric_id]) / scored_hours
                if scored_hours > 0
                else None
            )
            summary[f"metric_{metric_id}_scored_month_count"] = int(
                item["metric_month_counts"].get(metric_id, 0)
            )
            summary[f"metric_{metric_id}_scored_hours"] = round(scored_hours, 6)
            summary[f"metric_{metric_id}_total_weighted_avg"] = (
                round(weighted_score, 6) if weighted_score is not None else ""
            )
            score[label] = weighted_score if weighted_score is not None else ""

        summary_rows.append(summary)
        score_rows.append(score)

    return summary_rows, finalize_teacher_score_rows(score_rows)


def build_monthly_contribution_rows(
    monthly_results: Iterable[Dict[str, object]],
    feedback_month_offset: int,
) -> List[Dict[str, object]]:
    rows: List[Dict[str, object]] = []
    for result in monthly_results:
        report_month = str(result["month"])
        feedback_source_month = shift_month(report_month, feedback_month_offset)
        for summary in result["summary_rows"]:
            teacher_hours = float(summary.get("teacher_total_hours") or 0)
            if teacher_hours <= 0:
                continue
            row: Dict[str, object] = {
                "report_month": report_month,
                "feedback_source_month": feedback_source_month,
                "source_kind": result.get(
                    "source_kind",
                    "current_feedback_recalculation",
                ),
                "source_path": result.get("source_path", ""),
                "teacher": summary["teacher"],
                "teacher_total_hours": round(teacher_hours, 6),
                "response_record_count": int(
                    summary.get("response_record_count") or 0
                ),
                "matched_response_record_count": int(
                    summary.get("matched_response_record_count") or 0
                ),
                "coverage_rate": summary.get("coverage_rate", 0),
            }
            for metric_id, label in TEACHER_SCORE_EXPORT_METRICS:
                value = summary.get(f"metric_{metric_id}_total_normalized_avg")
                row[label] = (
                    round(float(value), 6) if value not in ("", None) else ""
                )
            rows.append(row)
    return rows


def generate_cumulative_feedback_report(
    *,
    feedback_csv: Path,
    schedule_csv: Path,
    output_dir: Path,
    name_map_csv: Optional[Path] = None,
    feedback_start_month: str = "",
    feedback_end_month: str = "",
    feedback_month_offset: int = 1,
    identities: str = "学生,家长/监护人",
    combine_mode: str = "merge_by_student",
    exclude_teachers_raw: str = "",
    include_cancelled: bool = False,
    max_duration_hours: float = 8.0,
    exclude_course_type_keywords: Optional[List[str]] = None,
    score_map_csv: Optional[Path] = None,
    history_root: Optional[Path] = DEFAULT_OUTPUT_ROOT,
    include_historical_outputs: bool = True,
) -> Dict[str, object]:
    feedback_csv = Path(feedback_csv).expanduser().resolve()
    schedule_csv = Path(schedule_csv).expanduser().resolve()
    output_dir = Path(output_dir).expanduser().resolve()
    name_map_csv = (
        Path(name_map_csv).expanduser().resolve()
        if name_map_csv is not None
        else DEFAULT_NAME_MAP
    )
    score_map_csv = (
        Path(score_map_csv).expanduser().resolve()
        if score_map_csv is not None
        else None
    )

    source_months = discover_feedback_source_months(
        feedback_csv,
        start_month=feedback_start_month,
        end_month=feedback_end_month,
    )
    if not source_months:
        raise SystemExit("指定反馈文件及月份范围内没有有效反馈")

    report_months = [
        shift_month(source_month, -feedback_month_offset)
        for source_month in source_months
    ]
    fresh_monthly_results = []
    with tempfile.TemporaryDirectory(prefix="jingshi-feedback-cumulative-") as tmp:
        temp_root = Path(tmp)
        for report_month in report_months:
            result = generate_monthly_feedback_report(
                    month=report_month,
                    feedback_csv=feedback_csv,
                    schedule_csv=schedule_csv,
                    output_dir=temp_root / report_month,
                    name_map_csv=name_map_csv,
                    identities=identities,
                    combine_mode=combine_mode,
                    exclude_teachers_raw=exclude_teachers_raw,
                    feedback_month_offset=feedback_month_offset,
                    include_cancelled=include_cancelled,
                    max_duration_hours=max_duration_hours,
                    exclude_course_type_keywords=exclude_course_type_keywords,
                    score_map_csv=score_map_csv,
                )
            result["source_kind"] = "current_feedback_recalculation"
            result["source_path"] = str(feedback_csv)
            fresh_monthly_results.append(result)

    combined_results_by_month: Dict[str, Dict[str, object]] = {}
    if include_historical_outputs and history_root is not None:
        resolved_history_root = Path(history_root).expanduser().resolve()
        historical_results = load_historical_monthly_results(
            resolved_history_root,
            through_report_month=max(report_months),
        )
        excluded_teachers = parse_name_set(exclude_teachers_raw)
        for historical_month, historical_result in historical_results.items():
            detail_path = resolved_history_root / historical_month / "respondent_detail.csv"
            if detail_path.exists():
                historical_result = rebuild_historical_result_from_detail(
                    report_month=historical_month,
                    detail_path=detail_path,
                    schedule_csv=schedule_csv,
                    name_map_csv=name_map_csv,
                    include_cancelled=include_cancelled,
                    max_duration_hours=max_duration_hours,
                    exclude_course_type_keywords=(
                        exclude_course_type_keywords
                        or ["请假", "假期", "空出", "文书", "会议", "课表确定"]
                    ),
                    excluded_teachers=excluded_teachers,
                )
            combined_results_by_month[historical_month] = historical_result
    for result in fresh_monthly_results:
        combined_results_by_month[str(result["month"])] = result
    monthly_results = [
        combined_results_by_month[month]
        for month in sorted(combined_results_by_month)
    ]
    all_report_months = [str(result["month"]) for result in monthly_results]
    historical_report_months = [
        str(result["month"])
        for result in monthly_results
        if str(result.get("source_kind", "")).startswith("historical_")
    ]

    summary_rows, score_rows = aggregate_monthly_summaries(
        (result["month"], result["summary_rows"]) for result in monthly_results
    )
    contribution_rows = build_monthly_contribution_rows(
        monthly_results,
        feedback_month_offset,
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    summary_fieldnames = [
        "teacher",
        "first_report_month",
        "last_report_month",
        "report_month_count",
        "teacher_total_hours",
        "response_record_count",
        "matched_response_record_count",
        "responded_student_hours",
        "coverage_rate",
    ]
    for metric_id, _ in TEACHER_SCORE_EXPORT_METRICS:
        summary_fieldnames.extend(
            [
                f"metric_{metric_id}_scored_month_count",
                f"metric_{metric_id}_scored_hours",
                f"metric_{metric_id}_total_weighted_avg",
            ]
        )
    score_fieldnames = [
        "排名",
        "老师",
        *[label for _, label in TEACHER_SCORE_EXPORT_METRICS],
        "总评分",
    ]
    contribution_fieldnames = [
        "report_month",
        "feedback_source_month",
        "source_kind",
        "source_path",
        "teacher",
        "teacher_total_hours",
        "response_record_count",
        "matched_response_record_count",
        "coverage_rate",
        *[label for _, label in TEACHER_SCORE_EXPORT_METRICS],
    ]
    write_csv(output_dir / "teacher_summary.csv", summary_rows, summary_fieldnames)
    write_csv(output_dir / "teacher_scores.csv", score_rows, score_fieldnames)
    write_csv(
        output_dir / "monthly_score_contributions.csv",
        contribution_rows,
        contribution_fieldnames,
    )

    run_meta = {
        "run_at": datetime.now().isoformat(timespec="seconds"),
        "input_feedback_csv": str(feedback_csv),
        "input_schedule_csv": str(schedule_csv),
        "input_name_map_csv": str(name_map_csv),
        "feedback_source_months": source_months,
        "report_months": all_report_months,
        "historical_report_months": historical_report_months,
        "recalculated_report_months": report_months,
        "feedback_month_offset": feedback_month_offset,
        "identities": identities,
        "combine_mode": combine_mode,
        "exclude_teachers": exclude_teachers_raw,
        "include_cancelled": include_cancelled,
        "max_duration_hours": max_duration_hours,
        "exclude_course_type_keywords": exclude_course_type_keywords,
        "score_map_csv": str(score_map_csv) if score_map_csv else "",
        "history_root": (
            str(Path(history_root).expanduser().resolve())
            if history_root is not None
            else ""
        ),
        "include_historical_outputs": include_historical_outputs,
        "aggregation": (
            "先按月度算法计算老师各指标分数，再以老师各月实际授课课时加权"
        ),
        "teacher_count": len(score_rows),
        "output_dir": str(output_dir),
        "output_files": [
            "teacher_scores.csv",
            "teacher_summary.csv",
            "monthly_score_contributions.csv",
            "run_meta.json",
        ],
    }
    (output_dir / "run_meta.json").write_text(
        json.dumps(run_meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "summary_rows": summary_rows,
        "score_rows": score_rows,
        "contribution_rows": contribution_rows,
        "run_meta": run_meta,
    }


def main() -> None:
    args = parse_args()
    result = generate_cumulative_feedback_report(
        feedback_csv=Path(args.feedback),
        schedule_csv=Path(args.schedule),
        output_dir=Path(args.output_dir),
        name_map_csv=Path(args.name_map),
        feedback_start_month=args.feedback_start_month,
        feedback_end_month=args.feedback_end_month,
        feedback_month_offset=args.feedback_month_offset,
        identities=args.identities,
        combine_mode=args.combine_mode,
        exclude_teachers_raw=args.exclude_teachers,
        include_cancelled=args.include_cancelled,
        max_duration_hours=args.max_duration_hours,
        exclude_course_type_keywords=[
            item.strip()
            for item in args.exclude_course_type_keywords.split(",")
            if item.strip()
        ],
        score_map_csv=Path(args.score_map) if args.score_map else None,
        history_root=Path(args.history_root),
        include_historical_outputs=not args.ignore_historical_outputs,
    )
    meta = result["run_meta"]
    print(
        f"[完成] 累计月报: {meta['report_months'][0]} 至 "
        f"{meta['report_months'][-1]}（共 {len(meta['report_months'])} 个月）"
    )
    print(f"[完成] 老师数: {meta['teacher_count']}")
    print(f"[完成] 输出目录: {meta['output_dir']}")


if __name__ == "__main__":
    main()
