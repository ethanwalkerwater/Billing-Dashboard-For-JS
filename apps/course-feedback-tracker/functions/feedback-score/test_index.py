"""python3 -m unittest functions/feedback-score/test_index.py（需 PYTHONPATH 指向 apps/teacher-feedback/scripts）"""
import unittest

import index

SCHEDULE = "上课时间,老师,学生,课程时长,课程类型,授课类型,临时取消\n" + "\n".join(
    [
        "2026-09-02 10:00:00,Valentina Lin,姚凯榕,2,IG数学,1v1,",
        "2026-09-03 10:00:00,数学杨老师,姚凯榕,1,IG数学,1v1,",
        "2026-09-04 10:00:00,窦老师,Mia,1,IG数学,1v1,",
        "2026-09-05 10:00:00,邓老师（地理）,Mia,1,IG地理,1v1,",
    ]
)
FEEDBACK = "提交时间,老师姓名,学生姓名,身份,【学生】学习提升效果,【学生】责任心与服务态度,【学生】个人魅力\n" + "\n".join(
    [
        "2026-10-01 10:00:00,Valentina 林,姚凯榕,学生本人,帮助非常大，进步明显,是的，始终如此，非常满意,非常出色，深深吸引我投入学习",
        # 同一身份第二份：keep=first 时不该覆盖第一份
        "2026-10-02 10:00:00,Valentina 林,姚凯榕,学生本人,帮助一般，提升有限,偶尔有所欠缺，但总体尚可,一般，课堂氛围较为平淡",
        "2026-10-01 11:00:00,数学杨,姚凯榕,学生本人,帮助较大，有一定提升,是的，始终如此，非常满意,较好，能够调动我的学习兴趣",
        "2026-10-01 12:00:00,窦,Mia,学生本人,帮助非常大，进步明显,是的，始终如此，非常满意,非常出色，深深吸引我投入学习",
    ]
)


class FeedbackScoreTest(unittest.TestCase):
    def test_live_month_aliases_display_names_exclusion_and_cumulative(self):
        result = index.main(
            {
                "months": [{"courseMonth": "2026-09", "scheduleCsv": SCHEDULE, "feedbackCsv": FEEDBACK, "dedupeKeep": "first", "countsTowardCumulative": True}],
                "history": [{"month": "2026-08", "rows": [{"teacher": "Valentina Lin", "hours": 100, "responses": 1, "matchedResponses": 1, "coverage": 1, "scores": {"learning_effect": 4.0, "responsibility": 4.0, "charisma": 4.0}}]}],
                "aliases": [{"kind": "teacher", "alias": "Valentina 林", "canonical": "Valentina Lin"}],
                "excludedTeachers": ["窦老师", "邓老师(地理)"],
                "teacherNames": ["Valentina Lin", "数学杨老师", "窦老师"],
                "detailMonth": "2026-09",
            }
        )
        self.assertTrue(result["ok"], result.get("error"))
        month = result["monthly"]["2026-09"]
        by_teacher = {row["teacher"]: row for row in month["teachers"]}
        # 显示名还原成课表写法；不统计的老师整个消失
        self.assertEqual({"Valentina Lin", "数学杨老师"}, set(by_teacher))
        # 只算第一份（5 分），第二份（3 分）不覆盖
        self.assertEqual(5.0, by_teacher["Valentina Lin"]["scores"]["learning_effect"])
        # 明细：重复的第二份去掉、不统计老师去掉，剩 2 份
        self.assertEqual(2, len(month["detail"]))
        # 累计：8 月 100 课时 4 分 + 9 月 2 课时 5 分，按课时加权
        cumulative = {row["teacher"]: row for row in result["cumulative"]["teachers"]}
        self.assertAlmostEqual((4 * 100 + 5 * 2) / 102, cumulative["Valentina Lin"]["scores"]["learning_effect"], places=3)
        self.assertEqual(["2026-08", "2026-09"], result["cumulative"]["months"])

    def test_month_without_feedback_reports_error_without_failing_others(self):
        result = index.main({"months": [{"courseMonth": "2026-09", "scheduleCsv": SCHEDULE, "feedbackCsv": "提交时间,老师姓名,学生姓名,身份\n"}]})
        self.assertTrue(result["ok"])
        self.assertIn("error", result["monthly"]["2026-09"])


if __name__ == "__main__":
    unittest.main()
