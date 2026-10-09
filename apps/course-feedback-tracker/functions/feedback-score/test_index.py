"""python3 -m unittest discover -s functions/feedback-score -p 'test_*.py'（PYTHONPATH 指向 apps/teacher-feedback/scripts）"""
import unittest

import index

SCHEDULE = "上课时间,老师,学生,课程时长,课程类型,授课类型,临时取消\n" + "\n".join(
    [
        "2026-09-02 10:00:00,Valentina Lin,姚凯榕,2,IG数学,1v1,",
        "2026-09-03 10:00:00,数学杨老师,姚凯榕,1,IG数学,1v1,",
        "2026-09-05 10:00:00,邓老师（地理）,Mia,1,IG地理,1v1,",
    ]
)
FEEDBACK = "提交时间,老师姓名,学生姓名,身份,【学生】学习提升效果,【学生】责任心与服务态度,【学生】个人魅力\n" + "\n".join(
    [
        "2026-10-01 10:00:00,Valentina 林,姚凯榕,学生本人,帮助非常大，进步明显,是的，始终如此，非常满意,非常出色，深深吸引我投入学习",
        # 同一身份第二份：keep=first 时不该覆盖第一份
        "2026-10-02 10:00:00,Valentina 林,姚凯榕,学生本人,帮助一般，提升有限,偶尔有所欠缺，但总体尚可,一般，课堂氛围较为平淡",
        "2026-10-01 11:00:00,数学杨,姚凯榕,学生本人,帮助较大，有一定提升,是的，始终如此，非常满意,较好，能够调动我的学习兴趣",
        "2026-10-01 12:00:00,邓老师(地理),Mia,学生本人,帮助非常大，进步明显,是的，始终如此，非常满意,非常出色，深深吸引我投入学习",
    ]
)
BASE = {
    "courseMonth": "2026-09",
    "scheduleCsv": SCHEDULE,
    "feedbackCsv": FEEDBACK,
    "dedupeKeep": "first",
    "aliases": [{"kind": "teacher", "alias": "Valentina 林", "canonical": "Valentina Lin"}],
    "teacherNames": ["Valentina Lin", "数学杨老师", "邓老师(地理)"],
}


class FeedbackScoreTest(unittest.TestCase):
    def test_aliases_display_names_fullwidth_and_first_submission(self):
        result = index.main(BASE)
        self.assertTrue(result["ok"], result.get("error"))
        by_teacher = {row["teacher"]: row for row in result["teachers"]}
        # 显示名还原成课表写法；全角括号与半角括号是同一个老师
        self.assertEqual({"Valentina Lin", "数学杨老师", "邓老师(地理)"}, set(by_teacher))
        # 只算第一份（5 分），第二份（3 分）不覆盖
        self.assertEqual(5.0, by_teacher["Valentina Lin"]["scores"]["learning_effect"])
        self.assertEqual(5.0, by_teacher["Valentina Lin"]["variants"]["learning_effect"]["student"])
        self.assertEqual(3, len(result["detail"]))

    def test_history_overlay_keeps_published_totals_and_adds_breakdowns(self):
        # 历史表里存的已经是课表写法（导入时换过名）
        published = {"teacher": "Valentina Lin", "hours": 100, "responses": 9, "matchedResponses": 9, "coverage": 0.5,
                     "scores": {"learning_effect": 4.2, "responsibility": 4.3, "charisma": 4.4}}
        result = index.main({**BASE, "history": [published]})
        row = result["teachers"][0]
        self.assertEqual("Valentina Lin", row["teacher"])
        self.assertEqual(4.2, row["scores"]["learning_effect"])
        self.assertEqual(100, row["hours"])
        self.assertEqual(5.0, row["variants"]["learning_effect"]["student"])
        self.assertEqual(1, row["rank"])

    def test_four_counts_as_five_rules(self):
        fours = "帮助较大，有一定提升,大部分时候能做到，整体良好,较好，能够调动我的学习兴趣"
        feedback = FEEDBACK.split("\n")[0] + "\n" + "\n".join(
            [
                # 姚凯榕给两位老师都只打 4 分 → 评分标准高
                f"2026-10-01 10:00:00,Valentina 林,姚凯榕,学生本人,{fours}",
                f"2026-10-01 11:00:00,数学杨,姚凯榕,学生本人,{fours}",
                # Mia 只评了一位老师，不算评分标准高；学习提升效果连续 3 个月打 4 分 → 连续 4 分
                f"2026-10-01 12:00:00,邓老师(地理),Mia,学生本人,{fours}",
            ]
        )
        streak = [{"student": "Mia", "teacher": "邓老师(地理)", "matched": True, "scores": {"learning_effect_student": 4}}]
        result = index.main({**BASE, "feedbackCsv": feedback, "priorDetails": [streak, streak, streak]})
        self.assertTrue(result["ok"], result.get("error"))
        scores = {row["teacher"]: row["scores"] for row in result["teachers"]}
        self.assertEqual(5.0, scores["Valentina Lin"]["charisma"])
        self.assertEqual(5.0, scores["数学杨老师"]["responsibility"])
        self.assertEqual(5.0, scores["邓老师(地理)"]["learning_effect"])
        self.assertEqual(4.0, scores["邓老师(地理)"]["charisma"])
        self.assertEqual({"streak": 1, "strict-rater": 6}, result["stats"]["adjustedScores"])
        mia = next(row for row in result["detail"] if row["student"] == "Mia")
        # 明细保留原始分，另记被改的字段
        self.assertEqual(4.0, mia["scores"]["learning_effect_student"])
        self.assertEqual({"learning_effect_student": "streak"}, mia["adjusted"])

        # 中间有一个月没排课：不算连续
        broken = [{**streak[0], "matched": False}]
        result = index.main({**BASE, "feedbackCsv": feedback, "priorDetails": [streak, broken, streak]})
        self.assertEqual(4.0, {row["teacher"]: row["scores"] for row in result["teachers"]}["邓老师(地理)"]["learning_effect"])

    def test_month_without_feedback_reports_error(self):
        result = index.main({**BASE, "feedbackCsv": "提交时间,老师姓名,学生姓名,身份\n"})
        self.assertFalse(result["ok"])
        self.assertIn("没有数据", result["error"])


if __name__ == "__main__":
    unittest.main()
