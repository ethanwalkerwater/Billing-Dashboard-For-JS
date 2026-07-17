import csv
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = APP_ROOT / "scripts/monthly_teacher_feedback.py"
SPEC = importlib.util.spec_from_file_location("monthly_teacher_feedback", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class MonthlyTeacherFeedbackTests(unittest.TestCase):
    def write_csv(self, path: Path, fieldnames, rows):
        with path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    def make_summary_row(self, teacher: str, *, response_count: int = 10):
        row = {
            "teacher": teacher,
            "teacher_total_hours": 10,
            "coverage_rate": 0.8,
            "response_record_count": response_count,
            "matched_response_record_count": max(response_count - 1, 0),
            "merged_response_record_count": max(response_count - 2, 0),
            "matched_merged_response_record_count": max(response_count - 3, 0),
            "responded_student_count": max(response_count - 3, 1),
        }
        for metric in MODULE.METRIC_VIEWS:
            for variant in metric["variants"]:
                prefix = f"metric_{metric['id']}_{variant['id']}"
                row[f"{prefix}_normalized_avg"] = metric["scale_max"]
                row[f"{prefix}_value_count"] = 1
        return row

    def minimal_feedback_fieldnames(self):
        fieldnames = ["提交时间", "老师姓名", "学生姓名", "身份"]
        fieldnames.extend(field["column"] for field in MODULE.NUMERIC_SCORE_FIELDS)
        for field in MODULE.TEXT_FEEDBACK_FIELDS:
            fieldnames.extend(field["columns"])
        return fieldnames

    def test_extract_scores_maps_text_choices_to_numbers(self):
        row = {
            "【家长】学习提升效果": "帮助非常大，孩子进步明显",
            "【学生】学习提升效果": "帮助较大，有一定提升",
            "【家长】责任心与服务态度": "偶尔有所欠缺，但总体尚可",
            "【学生】个人魅力": "非常出色，深深吸引我投入学习",
        }
        scores = MODULE.extract_scores(row)
        self.assertEqual(5.0, scores["learning_effect_parent"])
        self.assertEqual(4.0, scores["learning_effect_student"])
        self.assertEqual(3.0, scores["responsibility_parent"])
        self.assertEqual(5.0, scores["charisma_student"])

    def test_extract_scores_keeps_numeric_recommendation(self):
        row = {
            "【学生】推荐值": "10",
            "【家长】推荐值": "8",
            "【学生】责任心与服务态度": "5",
        }
        scores = MODULE.extract_scores(row)
        self.assertEqual(10.0, scores["recommendation_student"])
        self.assertEqual(8.0, scores["recommendation_parent"])
        self.assertEqual(5.0, scores["responsibility_student"])

    def test_extract_scores_supports_legacy_column_aliases(self):
        # 旧版合并列（无【家长/学生】前缀）应回退到学生维度字段。
        row = {"责任心与服务态度": "是的，始终如此，非常满意", "推荐度": "9"}
        scores = MODULE.extract_scores(row)
        self.assertEqual(5.0, scores["responsibility_student"])
        self.assertEqual(9.0, scores["recommendation_student"])

    def test_extract_scores_tolerates_punctuation_and_whitespace_variants(self):
        row = {"【学生】个人魅力": " 一般 课堂氛围较为平淡 "}
        scores = MODULE.extract_scores(row)
        self.assertEqual(3.0, scores["charisma_student"])

    def test_collect_unmapped_score_texts_flags_unknown_text(self):
        raw_records = [
            {"raw_row": {"【学生】个人魅力": "我也说不清楚", "【学生】责任心与服务态度": "5"}},
            {"raw_row": {"【学生】个人魅力": "我也说不清楚"}},
        ]
        unmapped = MODULE.collect_unmapped_score_texts(raw_records)
        self.assertEqual({"【学生】个人魅力": {"我也说不清楚": 2}}, unmapped)

    def test_analyze_org_fields_summarizes_satisfaction_and_strengths(self):
        raw_records = [
            {"raw_row": {"满意度": "非常满意", "机构优势": "师资, 升学结果"}},
            {"raw_row": {"满意度": "满意", "机构优势": "师资"}},
        ]
        analysis = MODULE.analyze_org_fields(raw_records)
        self.assertEqual(2, analysis["satisfaction"]["respondent_count"])
        self.assertEqual(
            {"非常满意": 1, "满意": 1}, analysis["satisfaction"]["distribution"]
        )
        self.assertEqual(2, analysis["org_strengths"]["distribution"]["师资"])
        self.assertEqual(1, analysis["org_strengths"]["distribution"]["升学结果"])

    def test_build_teacher_score_table_outputs_three_metrics(self):
        summary_rows = [self.make_summary_row("包天翊")]
        rows, fieldnames = MODULE.build_teacher_score_table(summary_rows)
        self.assertEqual(["老师", "学习提升效果", "责任心与服务态度", "个人魅力"], fieldnames)
        self.assertEqual("包天翊", rows[0]["老师"])
        # make_summary_row sets each total normalized_avg to scale_max (5)
        self.assertEqual(5.0, rows[0]["学习提升效果"])
        self.assertEqual(5.0, rows[0]["责任心与服务态度"])
        self.assertEqual(5.0, rows[0]["个人魅力"])

    def test_generate_report_writes_teacher_scores_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            feedback_csv = tmp_path / "feedback.csv"
            schedule_csv = tmp_path / "schedule.csv"
            output_dir = tmp_path / "result"
            self.write_csv(
                feedback_csv,
                self.minimal_feedback_fieldnames(),
                [
                    {
                        "提交时间": "2026/05/09",
                        "老师姓名": "黄钢",
                        "学生姓名": "Alice",
                        "身份": "学生本人",
                        "【学生】个人魅力": "非常出色，深深吸引我投入学习",
                    }
                ],
            )
            self.write_csv(
                schedule_csv,
                ["上课时间", "老师", "学生", "课程时长", "课程类型", "临时取消"],
                [
                    {
                        "上课时间": "2026/04/08 10:00",
                        "老师": "黄钢",
                        "学生": "Alice-001",
                        "课程时长": "2",
                        "课程类型": "雅思",
                        "临时取消": "",
                    }
                ],
            )
            MODULE.generate_monthly_feedback_report(
                month="2026-04",
                feedback_csv=feedback_csv,
                schedule_csv=schedule_csv,
                output_dir=output_dir,
                feedback_start_date="2026-05-01",
                feedback_end_date="2026-05-11",
            )
            scores_path = output_dir / "teacher_scores.csv"
            self.assertTrue(scores_path.exists())
            with scores_path.open(encoding="utf-8-sig") as scores_file:
                rows = list(csv.DictReader(scores_file))
            self.assertEqual("黄钢", rows[0]["老师"])
            self.assertEqual("5.0", rows[0]["个人魅力"])

    def test_read_feedback_latest_uses_offset_month(self):
        with tempfile.TemporaryDirectory() as tmp:
            feedback_csv = Path(tmp) / "feedback.csv"
            self.write_csv(
                feedback_csv,
                ["提交时间", "老师名", "学员名", "填写人身份"],
                [
                    {
                        "提交时间": "2026/02/05",
                        "老师名": "包天翊",
                        "学员名": "Charlie",
                        "填写人身份": "学生",
                    },
                    {
                        "提交时间": "2026/03/09",
                        "老师名": "包天翊",
                        "学员名": "Charlie",
                        "填写人身份": "学生",
                    },
                    {
                        "提交时间": "2026/03/09",
                        "老师名": "包天翊",
                        "学员名": "Kelvin",
                        "填写人身份": "学生",
                    },
                ],
            )

            records, stats = MODULE.read_feedback_latest(
                feedback_csv=feedback_csv,
                month="2026-02",
                identity_filter=None,
                teacher_map={},
                student_map={},
                feedback_month_offset=1,
            )

            self.assertEqual(2, len(records))
            self.assertEqual(2, stats["feedback_rows_in_month"])
            self.assertEqual({"Charlie", "Kelvin"}, {r["student"] for r in records})

    def test_read_feedback_latest_supports_explicit_feedback_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            feedback_csv = Path(tmp) / "feedback.csv"
            self.write_csv(
                feedback_csv,
                ["提交时间", "老师名", "学员名", "填写人身份"],
                [
                    {
                        "提交时间": "2026/03/26",
                        "老师名": "包天翊",
                        "学员名": "Charlie",
                        "填写人身份": "学生",
                    },
                    {
                        "提交时间": "2026/03/27",
                        "老师名": "包天翊",
                        "学员名": "Charlie",
                        "填写人身份": "学生",
                    },
                    {
                        "提交时间": "2026/04/09",
                        "老师名": "包天翊",
                        "学员名": "Kelvin",
                        "填写人身份": "学生",
                    },
                    {
                        "提交时间": "2026/04/13",
                        "老师名": "包天翊",
                        "学员名": "Lucas",
                        "填写人身份": "学生",
                    },
                ],
            )

            records, stats = MODULE.read_feedback_latest(
                feedback_csv=feedback_csv,
                month="2026-03",
                identity_filter=None,
                teacher_map={},
                student_map={},
                feedback_month_offset=1,
                feedback_start_date="2026-03-27",
                feedback_end_date="2026-04-12",
            )

            self.assertEqual(2, len(records))
            self.assertEqual(2, stats["feedback_rows_in_month"])
            self.assertEqual({"Charlie", "Kelvin"}, {r["student"] for r in records})

    def test_teacher_summary_counts_raw_feedback_records(self):
        raw_feedback_records = [
            {
                "teacher": "包天翊",
                "student": "Gavin",
                "identity": "学生",
                "submitted_at": None,
                "raw_row": {},
            },
            {
                "teacher": "包天翊",
                "student": "Gavin",
                "identity": "家长/监护人",
                "submitted_at": None,
                "raw_row": {},
            },
            {
                "teacher": "包天翊",
                "student": "Kelvin",
                "identity": "学生",
                "submitted_at": None,
                "raw_row": {},
            },
        ]

        merged_records = [
            MODULE.FeedbackRecord(
                teacher="包天翊",
                student="Gavin",
                student_raw_name="Gavin",
                identity="合并",
                source_identities="学生|家长/监护人",
                submitted_at="2026-03-09 00:00:00",
                scores={field["id"]: None for field in MODULE.NUMERIC_SCORE_FIELDS},
            ),
            MODULE.FeedbackRecord(
                teacher="包天翊",
                student="Kelvin",
                student_raw_name="Kelvin",
                identity="合并",
                source_identities="学生",
                submitted_at="2026-03-09 00:00:00",
                scores={field["id"]: None for field in MODULE.NUMERIC_SCORE_FIELDS},
            ),
        ]
        MODULE.apply_weights(
            records=merged_records,
            teacher_total_hours={"包天翊": 4.0},
            teacher_student_hours={("包天翊", "Gavin"): 2.0, ("包天翊", "Kelvin"): 2.0},
            student_total_hours={"Gavin": 2.0, "Kelvin": 2.0},
        )

        summary = MODULE.build_teacher_summary(
            records=merged_records,
            teacher_total_hours={"包天翊": 4.0},
            teacher_student_hours={("包天翊", "Gavin"): 2.0, ("包天翊", "Kelvin"): 2.0},
            raw_feedback_records=raw_feedback_records,
        )

        self.assertEqual("3", str(summary[0]["response_record_count"]))
        self.assertEqual("2", str(summary[0]["merged_response_record_count"]))

    def test_teacher_summary_fills_missing_student_scores_with_month_metric_average(self):
        raw_feedback_records = [
            {
                "teacher": "老师A",
                "student": "学生1",
                "identity": "学生",
                "submitted_at": None,
                "raw_row": {},
            },
            {
                "teacher": "老师B",
                "student": "学生3",
                "identity": "学生",
                "submitted_at": None,
                "raw_row": {},
            },
        ]

        score_template = {field["id"]: None for field in MODULE.NUMERIC_SCORE_FIELDS}
        rec_a = MODULE.FeedbackRecord(
            teacher="老师A",
            student="学生1",
            student_raw_name="学生1",
            identity="合并",
            source_identities="学生",
            submitted_at="2026-05-09 00:00:00",
            scores={**score_template, "responsibility_student": 5.0},
        )
        rec_b = MODULE.FeedbackRecord(
            teacher="老师B",
            student="学生3",
            student_raw_name="学生3",
            identity="合并",
            source_identities="学生",
            submitted_at="2026-05-09 00:00:00",
            scores={**score_template, "responsibility_student": 3.0},
        )
        records = [rec_a, rec_b]

        MODULE.apply_weights(
            records=records,
            teacher_total_hours={"老师A": 4.0, "老师B": 4.0},
            teacher_student_hours={
                ("老师A", "学生1"): 2.0,
                ("老师A", "学生2"): 2.0,
                ("老师B", "学生3"): 4.0,
            },
            student_total_hours={"学生1": 2.0, "学生2": 2.0, "学生3": 4.0},
        )

        summary = MODULE.build_teacher_summary(
            records=records,
            teacher_total_hours={"老师A": 4.0, "老师B": 4.0},
            teacher_student_hours={
                ("老师A", "学生1"): 2.0,
                ("老师A", "学生2"): 2.0,
                ("老师B", "学生3"): 4.0,
            },
            raw_feedback_records=raw_feedback_records,
        )

        summary_by_teacher = {row["teacher"]: row for row in summary}
        teacher_a = summary_by_teacher["老师A"]

        self.assertEqual("1", str(teacher_a["response_record_count"]))
        self.assertEqual("1", str(teacher_a["metric_responsibility_total_value_count"]))
        self.assertEqual("0.5", str(teacher_a["coverage_rate"]))
        self.assertAlmostEqual(
            4.333333,
            float(teacher_a["metric_responsibility_total_normalized_avg"]),
            places=5,
        )

    def test_filter_excluded_teachers_removes_them_from_outputs(self):
        records = [
            MODULE.FeedbackRecord(
                teacher="窦",
                student="A",
                student_raw_name="A",
                identity="合并",
                source_identities="学生",
                submitted_at="2026-05-09 00:00:00",
                scores={field["id"]: None for field in MODULE.NUMERIC_SCORE_FIELDS},
            ),
            MODULE.FeedbackRecord(
                teacher="蒋妍",
                student="B",
                student_raw_name="B",
                identity="合并",
                source_identities="学生",
                submitted_at="2026-05-09 00:00:00",
                scores={field["id"]: None for field in MODULE.NUMERIC_SCORE_FIELDS},
            ),
            MODULE.FeedbackRecord(
                teacher="黄钢",
                student="C",
                student_raw_name="C",
                identity="合并",
                source_identities="学生",
                submitted_at="2026-05-09 00:00:00",
                scores={field["id"]: None for field in MODULE.NUMERIC_SCORE_FIELDS},
            ),
        ]
        teacher_total_hours = {"窦": 1.0, "蒋妍": 2.0, "黄钢": 3.0}
        teacher_student_hours = {("窦", "A"): 1.0, ("蒋妍", "B"): 2.0, ("黄钢", "C"): 3.0}
        raw_feedback_records = [
            {"teacher": "窦", "student": "A"},
            {"teacher": "蒋妍", "student": "B"},
            {"teacher": "黄钢", "student": "C"},
        ]

        filtered = MODULE.filter_excluded_teachers(
            records=records,
            teacher_total_hours=teacher_total_hours,
            teacher_student_hours=teacher_student_hours,
            raw_feedback_records=raw_feedback_records,
            excluded_teachers={"窦", "蒋妍"},
        )

        self.assertEqual(["黄钢"], [r.teacher for r in filtered["records"]])
        self.assertEqual({"黄钢": 3.0}, filtered["teacher_total_hours"])
        self.assertEqual({("黄钢", "C"): 3.0}, filtered["teacher_student_hours"])
        self.assertEqual([{"teacher": "黄钢", "student": "C"}], filtered["raw_feedback_records"])

    def test_generate_monthly_feedback_report_writes_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            feedback_csv = tmp_path / "feedback.csv"
            schedule_csv = tmp_path / "schedule.csv"
            output_dir = tmp_path / "result"

            feedback_rows = [
                {
                    "提交时间": "2026/05/09",
                    "老师姓名": "黄钢",
                    "学生姓名": "Alice",
                    "身份": "学生本人",
                    "【学生】责任心与服务态度": "是的，始终如此，非常满意",
                    "【学生】推荐值": "10",
                }
            ]
            self.write_csv(
                feedback_csv,
                self.minimal_feedback_fieldnames(),
                feedback_rows,
            )
            self.write_csv(
                schedule_csv,
                ["上课时间", "老师", "学生", "课程时长", "课程类型", "临时取消"],
                [
                    {
                        "上课时间": "2026/04/08 10:00",
                        "老师": "黄钢",
                        "学生": "Alice-001",
                        "课程时长": "2",
                        "课程类型": "雅思",
                        "临时取消": "",
                    }
                ],
            )

            result = MODULE.generate_monthly_feedback_report(
                month="2026-04",
                feedback_csv=feedback_csv,
                schedule_csv=schedule_csv,
                output_dir=output_dir,
                feedback_start_date="2026-05-01",
                feedback_end_date="2026-05-11",
            )

            self.assertTrue((output_dir / "teacher_summary.csv").exists())
            self.assertTrue((output_dir / "run_meta.json").exists())
            self.assertEqual("2026-04", result["run_meta"]["month"])
            self.assertEqual("2026-05-01", result["run_meta"]["feedback_start_date"])
            self.assertEqual(1, len(result["summary_rows"]))

    def test_compute_chart_highlight_flags_treats_five_point_full_score_majority_as_top_half(self):
        flags = MODULE.compute_chart_highlight_flags(
            values=[5.0, 5.0, 5.0, 4.8],
            scale_max=5,
            is_percent=False,
        )

        self.assertEqual([True, True, True, False], flags)

    def test_dashboard_html_keeps_feedback_count_and_total_hours_in_tooltip_and_draws_score_above_bars(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "dashboard.html"
            summary_rows = [self.make_summary_row("包天翊")]
            feedback_records = [
                MODULE.FeedbackRecord(
                    teacher="包天翊",
                    student="Kelvin",
                    student_raw_name="Kelvin",
                    identity="学生",
                    source_identities="学生",
                    submitted_at="2026-03-09 00:00:00",
                    scores={field["id"]: 5 for field in MODULE.NUMERIC_SCORE_FIELDS},
                    matched=True,
                    student_teacher_hours=2,
                )
            ]

            MODULE.write_dashboard_html(out, "2026-02", summary_rows, feedback_records)
            html = out.read_text(encoding="utf-8")

            self.assertIn("tooltip", html)
            self.assertIn("反馈数:", html)
            self.assertIn("课时总数:", html)
            self.assertIn("totalHours", html)
            self.assertNotIn("feedbackCountPlugin", html)
            self.assertIn('id: "barValueLabelPlugin"', html)
            self.assertIn("afterDatasetsDraw", html)

    def test_dashboard_html_sorts_equal_displayed_scores_by_total_hours(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "dashboard.html"
            low_hours = self.make_summary_row("老师A")
            high_hours = self.make_summary_row("老师B")
            low_hours["teacher_total_hours"] = 4
            high_hours["teacher_total_hours"] = 8

            MODULE.write_dashboard_html(out, "2026-02", [low_hours, high_hours], [])
            html = out.read_text(encoding="utf-8")

            self.assertIn("function getDisplaySortValue", html)
            self.assertIn("const displayPrecision = metric.isPercent ? 1 : 3;", html)
            self.assertIn("function compareMetricRows(metric, a, b)", html)
            self.assertIn("const hourDiff = b.totalHours - a.totalHours;", html)
            self.assertIn("sort((a, b) => compareMetricRows(metric, a, b))", html)
            self.assertIn("展示分值相同按总课时", html)

    def test_dashboard_html_can_exclude_teachers_from_display(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "dashboard.html"
            MODULE.write_dashboard_html(
                out,
                "2026-02",
                [self.make_summary_row("老师A"), self.make_summary_row("老师B")],
                [],
            )
            html = out.read_text(encoding="utf-8")

            self.assertIn('id="teacherFilterList"', html)
            self.assertIn('id="teacherFilterSearch"', html)
            self.assertIn('id="clearTeacherFilter"', html)
            self.assertIn('class="teacher-filter-popover"', html)
            self.assertIn('id="excludedTeacherChips"', html)
            self.assertNotIn('<section class="teacher-filter"', html)
            self.assertIn("const excludedTeachers = new Set();", html)
            self.assertIn("function getVisibleRows", html)
            self.assertIn("return getVisibleRows().map", html)
            self.assertIn("const bodyRows = getVisibleRows()", html)

    def test_dashboard_html_supports_saved_detail_rows_for_template_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "dashboard.html"
            summary_rows = [self.make_summary_row("老师A")]
            detail_rows = [
                {
                    "teacher": "老师A",
                    "student": "学员A",
                    "student_raw_name": "学员A",
                    "student_teacher_hours": "6.5",
                    "matched": "1",
                    "score_learning_effect_student": "5",
                }
            ]

            MODULE.write_dashboard_html(
                out,
                "2026-02",
                summary_rows,
                [],
                detail_rows_override=detail_rows,
            )
            html = out.read_text(encoding="utf-8")

            self.assertIn('"student_raw_name": "学员A"', html)
            self.assertIn('"student_teacher_hours": "6.5"', html)
            self.assertIn('"score_learning_effect_student": "5"', html)

    def test_dashboard_html_emphasizes_chart_card_without_changing_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "dashboard.html"
            summary_rows = [self.make_summary_row("包天翊")]

            MODULE.write_dashboard_html(out, "2026-02", summary_rows, [])
            html = out.read_text(encoding="utf-8")

            self.assertIn('class="card chart-card"', html)
            self.assertIn(".chart-card .chart-wrap", html)
            self.assertIn('id="textTable"', html)
            self.assertNotIn('id="overviewStats"', html)

    def test_web_frontend_uses_separate_dashboard_page(self):
        index_html = (APP_ROOT / "public/index.html").read_text(encoding="utf-8")
        dashboard_page = APP_ROOT / "public/dashboard.html"

        self.assertTrue(dashboard_page.exists())
        self.assertIn("localStorage.setItem", index_html)
        self.assertIn('window.location.href = "/dashboard.html"', index_html)

        dashboard_html = dashboard_page.read_text(encoding="utf-8")
        self.assertIn('fetch("/api/render_dashboard"', dashboard_html)
        self.assertIn('file.name === "respondent_detail.csv"', dashboard_html)
        self.assertIn("refreshDashboardHtml(payload)", dashboard_html)


if __name__ == "__main__":
    unittest.main()
