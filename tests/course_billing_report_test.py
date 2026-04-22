import unittest

from scripts.course_billing_report import (
    aggregate_records,
    normalize_row,
    parse_cancellation_rate,
)


def make_row(**overrides):
    row = {
        "学员课程ID": "id-1",
        "课程类型": "Alevel数学",
        "老师": "张老师",
        "学生": "学生A-101",
        "上课时间": "2026/03/01 10:00",
        "下课时间": "2026/03/01 12:00",
        "课程单价": "1000",
        "课程时长": "2",
        "课程总价格": "2000",
        "临时取消": "",
        "授课类型": "1v1",
        "上课地点": "文定",
        "日程 ID": "event-1",
    }
    row.update(overrides)
    return row


class CourseBillingReportTest(unittest.TestCase):
    def test_parse_cancellation_rate_from_label(self):
        self.assertEqual(parse_cancellation_rate("0h-70%"), 0.7)
        self.assertEqual(parse_cancellation_rate("2h-50%"), 0.5)
        self.assertEqual(parse_cancellation_rate("6h-30%"), 0.3)
        self.assertIsNone(parse_cancellation_rate(""))
        self.assertIsNone(parse_cancellation_rate("请假"))

    def test_student_view_keeps_teaching_type_and_cancellation_separate(self):
        records = [
            normalize_row(make_row(课程总价格="2000"), 2),
            normalize_row(
                make_row(
                    授课类型="刷题班",
                    课程单价="350",
                    课程时长="1.5",
                    课程总价格="525",
                    上课时间="2026/03/02 10:00",
                    日程_ID="event-2",
                ),
                3,
            ),
            normalize_row(
                make_row(
                    临时取消="0h-70%",
                    课程总价格="1400",
                    上课时间="2026/03/03 10:00",
                    日程_ID="event-3",
                ),
                4,
            ),
        ]

        result = aggregate_records(records, "student", "2026-03", "学生A-101")

        self.assertEqual(result["totals"]["amount"], 3925)
        self.assertEqual(result["totals"]["duration"], 5.5)
        self.assertEqual(result["totals"]["cancelledAmount"], 1400)
        self.assertEqual(result["totals"]["cancelledDuration"], 2)
        self.assertEqual(len(result["groups"]), 3)
        self.assertEqual(
            {(g["courseType"], g["teachingType"], g["cancellationStatus"]) for g in result["groups"]},
            {
                ("Alevel数学", "1v1", "正常上课"),
                ("Alevel数学", "刷题班", "正常上课"),
                ("Alevel数学", "1v1", "0h-70%"),
            },
        )
        cancelled = next(g for g in result["groups"] if g["cancellationStatus"] == "0h-70%")
        self.assertEqual(cancelled["rawRows"], [4])

    def test_teacher_view_groups_by_student(self):
        records = [
            normalize_row(make_row(学生="学生A-101", 课程总价格="2000"), 2),
            normalize_row(make_row(学生="学生B-202", 课程总价格="2000"), 3),
        ]

        result = aggregate_records(records, "teacher", "2026-03", "张老师")

        self.assertEqual(result["totals"]["amount"], 4000)
        self.assertEqual([g["counterparty"] for g in result["groups"]], ["学生A-101", "学生B-202"])

    def test_quality_issues_expose_source_mismatches_and_missing_dimensions(self):
        mismatch = normalize_row(make_row(课程总价格="1999"), 2)
        missing_student = normalize_row(make_row(学生=" ", 课程总价格="2000"), 3)

        result = aggregate_records([mismatch, missing_student], "teacher", "2026-03", "张老师")

        issue_codes = {issue["code"] for issue in result["qualityIssues"]}
        self.assertIn("amount_mismatch", issue_codes)
        self.assertIn("missing_student", issue_codes)


if __name__ == "__main__":
    unittest.main()
