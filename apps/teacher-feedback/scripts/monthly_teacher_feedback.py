#!/usr/bin/env python3
"""
月度老师反馈加权统计工具

核心口径：
1) 仅统计指定月份（YYYY-MM）的反馈与课表；
2) 老师总课时 = 当月该老师所有非取消课程的课程时长之和；
3) 反馈影响权重 = 学员当月在该老师名下课时 / 老师当月总课时；
4) 支持按填写人身份筛选（学生 / 家长/监护人 / 全部）；
5) 支持老师名、学员名映射修正，便于持续清洗数据。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


APP_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = APP_ROOT.parent.parent
PRIVATE_DATA_ROOT = REPO_ROOT / "data/private/teacher-feedback"
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "outputs/teacher-feedback"
DEFAULT_NAME_MAP = APP_ROOT / "templates/name_mapping.csv"


# 单条评分字段。每个字段对应反馈表里的一列。
# "column" 为新版问卷列名；"aliases" 为旧版列名（向后兼容，读取时按顺序回退）。
# 新版问卷把责任心/个人魅力/推荐值都拆成了【家长】/【学生】两列，因此这里分开建字段，
# 再由 METRIC_VIEWS 合并成“总/学生/家长”可切换的指标。
NUMERIC_SCORE_FIELDS = [
    {
        "id": "learning_effect_student",
        "label": "学习提升效果-学生",
        "column": "【学生】学习提升效果",
    },
    {
        "id": "learning_effect_parent",
        "label": "学习提升效果-家长",
        "column": "【家长】学习提升效果",
    },
    {
        "id": "responsibility_student",
        "label": "责任心与服务态度-学生",
        "column": "【学生】责任心与服务态度",
        "aliases": ["责任心与服务态度"],
    },
    {
        "id": "responsibility_parent",
        "label": "责任心与服务态度-家长",
        "column": "【家长】责任心与服务态度",
    },
    {
        "id": "charisma_student",
        "label": "个人魅力-学生",
        "column": "【学生】个人魅力",
        "aliases": ["个人魅力"],
    },
    {
        "id": "charisma_parent",
        "label": "个人魅力-家长",
        "column": "【家长】个人魅力",
    },
    {
        "id": "recommendation_student",
        "label": "推荐度-学生",
        "column": "【学生】推荐值",
        "aliases": ["推荐度"],
    },
    {
        "id": "recommendation_parent",
        "label": "推荐度-家长",
        "column": "【家长】推荐值",
    },
]

# 文本型选项 -> 分值 的默认对应表。
# 背景：部分指标（尤其是【家长】维度）从“1-5 数值”改为“文本选项”，
# 这里把每个文本选项映射回 1-5 分，使其能继续参与加权评分。
# 说明：
# - 同一段文本在“家长/学生”不同问法中若分值一致，可安全共用（已核对无冲突）。
# - “责任心与服务态度”“个人魅力”在数据里是合并列，因此把家长+学生两套文案都纳入。
# - 匹配时会先按文本表查，再回退到数字解析，所以老数据（纯数字）与
#   “5分 − 高效回复”这类带数字前缀的文案都能继续正常工作。
TEXT_SCORE_RUBRIC: List[Tuple[str, float]] = [
    # 学习提升效果（家长）
    ("帮助非常大，孩子进步明显", 5),
    ("帮助较大，孩子有一定提升", 4),
    ("帮助一般，提升较为有限", 3),
    ("帮助不大，收获较少", 2),
    # 学习提升效果（学生）
    ("帮助非常大，进步明显", 5),
    ("帮助较大，有一定提升", 4),
    ("帮助一般，提升有限", 3),
    # 责任心与服务态度（家长/学生文案一致）
    ("是的，始终如此，非常满意", 5),
    ("大部分时候能做到，整体良好", 4),
    ("偶尔有所欠缺，但总体尚可", 3),
    ("有较明显的不足，希望改进", 2),
    # 个人魅力（家长）
    ("影响力非常显著，孩子在学习态度、思维方式和成绩上均有明显改变", 5),
    ("影响力较为积极，孩子的学习状态和兴趣有所提升", 4),
    ("影响力一般，孩子暂未呈现出明显的改变", 3),
    ("影响力有待加强，孩子的学习状态未见明显改善", 2),
    # 个人魅力（学生）
    ("非常出色，深深吸引我投入学习", 5),
    ("较好，能够调动我的学习兴趣", 4),
    ("一般，课堂氛围较为平淡", 3),
    ("有待提升，较难引发我的学习热情", 2),
]

METRIC_VIEWS = [
    {
        "id": "learning_effect",
        "label": "学习提升效果",
        "description": "学员对学习效果提升的评分（1-5）。支持总/学生/家长维度切换。",
        "scale_max": 5,
        "variants": [
            {
                "id": "total",
                "label": "总",
                "score_ids": ["learning_effect_student", "learning_effect_parent"],
            },
            {
                "id": "student",
                "label": "学生",
                "score_ids": ["learning_effect_student"],
            },
            {
                "id": "parent",
                "label": "家长",
                "score_ids": ["learning_effect_parent"],
            },
        ],
    },
    {
        "id": "responsibility",
        "label": "责任心与服务态度",
        "description": "对老师责任心与服务体验的评分（1-5）。支持总/学生/家长维度切换。",
        "scale_max": 5,
        "variants": [
            {
                "id": "total",
                "label": "总",
                "score_ids": ["responsibility_student", "responsibility_parent"],
            },
            {"id": "student", "label": "学生", "score_ids": ["responsibility_student"]},
            {"id": "parent", "label": "家长", "score_ids": ["responsibility_parent"]},
        ],
    },
    {
        "id": "charisma",
        "label": "个人魅力",
        "description": "对课堂吸引力与老师个人魅力的评分（1-5）。支持总/学生/家长维度切换。",
        "scale_max": 5,
        "variants": [
            {
                "id": "total",
                "label": "总",
                "score_ids": ["charisma_student", "charisma_parent"],
            },
            {"id": "student", "label": "学生", "score_ids": ["charisma_student"]},
            {"id": "parent", "label": "家长", "score_ids": ["charisma_parent"]},
        ],
    },
    {
        "id": "recommendation",
        "label": "推荐度",
        "description": "整体推荐意愿评分（0-10）。支持总/学生/家长维度切换。",
        "scale_max": 10,
        "variants": [
            {
                "id": "total",
                "label": "总",
                "score_ids": ["recommendation_student", "recommendation_parent"],
            },
            {"id": "student", "label": "学生", "score_ids": ["recommendation_student"]},
            {"id": "parent", "label": "家长", "score_ids": ["recommendation_parent"]},
        ],
    },
]

TEXT_FEEDBACK_FIELDS = [
    {
        "id": "improvement_student",
        "label": "学员改进反馈",
        "description": "学员给出的改进建议（含补充）。",
        "columns": ["【学生】改进方面", "【学生】改进方面其他", "【学员】改进方面", "【学员】改进方面其他"],
    },
    {
        "id": "improvement_parent",
        "label": "家长改进反馈",
        "description": "家长/监护人给出的改进建议（含补充）。",
        "columns": ["【家长】改进方面", "【家长】改进方面其他"],
    },
    {
        "id": "suggestion",
        "label": "其他建议",
        "description": "问卷中填写的其他建议。",
        "columns": ["建议"],
    },
]

# 机构层面（非老师维度）的单独分析字段：满意度、机构优势等。
# 这些不计入老师加权评分，仅做整体分布统计写入 run_meta。
ORG_ANALYSIS_FIELDS = [
    {
        "id": "satisfaction",
        "label": "机构整体满意度",
        "column": "满意度",
        "kind": "single",
    },
    {
        "id": "org_strengths",
        "label": "机构优势",
        "column": "机构优势",
        "other_column": "机构优势其他",
        "kind": "multi",
    },
]

COVERAGE_METRIC = {
    "id": "coverage_rate",
    "label": "覆盖率",
    "description": "覆盖率 = 产生有效匹配反馈的去重学员课时 / 老师总课时。用于衡量样本覆盖程度。",
    "scale_max": 100,
    "is_percent": True,
}

DATE_FORMATS = [
    "%Y/%m/%d %H:%M",
    "%Y/%m/%d",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
]

TRAILING_STUDENT_CODE_RE = re.compile(r"-[A-Za-z0-9]*$")
WHITESPACE_RE = re.compile(r"\s+")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
TEXT_SPLIT_RE = re.compile(r"\s*\|\|\s*|\s*\|\s*")
# 用于把“文本型选项”归一化后匹配评分（去掉空白与常见标点、大小写无关），
# 让问卷里的文字答案能稳健对应到分值，避免标点/空格写法差异导致匹配失败。
CHOICE_PUNCT_RE = re.compile(r"[\s，,。.、；;：:！!？?・·\-—–_（）()【】\[\]\"'“”‘’]+")


@dataclass
class FeedbackRecord:
    teacher: str
    student: str
    student_raw_name: str
    identity: str
    source_identities: str
    submitted_at: str
    scores: Dict[str, Optional[float]]
    text_feedback: Dict[str, str] = field(default_factory=dict)
    teacher_total_hours: float = 0.0
    student_teacher_hours: float = 0.0
    student_total_hours: float = 0.0
    raw_weight: float = 0.0
    normalized_weight: float = 0.0
    matched: bool = False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="月度老师反馈加权统计")
    parser.add_argument("--month", required=True, help="统计月份，例如 2026-02")
    parser.add_argument(
        "--feedback",
        default=str(PRIVATE_DATA_ROOT / "feedback.csv"),
        help="反馈 CSV 路径",
    )
    parser.add_argument(
        "--schedule",
        default=str(PRIVATE_DATA_ROOT / "schedule.csv"),
        help="课表 CSV 路径",
    )
    parser.add_argument(
        "--identities",
        default="学生,家长/监护人",
        help="填写人身份筛选，逗号分隔；用 all 表示不过滤",
    )
    parser.add_argument(
        "--combine-mode",
        choices=["merge_by_student", "independent"],
        default="merge_by_student",
        help=(
            "反馈合并策略：merge_by_student=同一老师-学员下不同身份反馈先合并；"
            "independent=不同身份独立计权。"
        ),
    )
    parser.add_argument(
        "--feedback-month-offset",
        type=int,
        default=1,
        help="报表月份对应的反馈提交月份偏移。默认 1，表示 2 月报表读取 3 月提交反馈。",
    )
    parser.add_argument(
        "--feedback-start-date",
        default="",
        help=(
            "显式指定反馈统计起始时间（含），格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM。"
            "提供后会覆盖按月份偏移筛选。"
        ),
    )
    parser.add_argument(
        "--feedback-end-date",
        default="",
        help=(
            "显式指定反馈统计结束时间（含），格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM。"
            "若只写日期，会自动按当天结束处理。"
        ),
    )
    parser.add_argument(
        "--include-cancelled",
        action="store_true",
        help="是否把临时取消课程纳入总课时（默认不纳入）",
    )
    parser.add_argument(
        "--max-duration-hours",
        type=float,
        default=8.0,
        help="单节课最大时长阈值（小时），超过则默认视作异常占位事件并剔除",
    )
    parser.add_argument(
        "--exclude-course-type-keywords",
        default="请假,假期,空出,文书,会议,课表确定",
        help="课程类型过滤关键词（逗号分隔，命中则剔除）",
    )
    parser.add_argument(
        "--name-map",
        default=str(DEFAULT_NAME_MAP),
        help=(
            "姓名映射 CSV 路径（可选）。格式：entity,raw,normalized。"
            "entity 取 teacher/student。"
        ),
    )
    parser.add_argument(
        "--exclude-teachers",
        default="",
        help="要从结果中排除展示的老师名，逗号分隔。",
    )
    parser.add_argument(
        "--score-map",
        default="",
        help=(
            "额外的“文本选项->分值”映射 CSV（可选）。格式：每行“答案文本,分值”，"
            "分组标题行可留空第二列。内置映射已覆盖学习提升效果/责任心/个人魅力，"
            "此参数用于追加或覆盖新出现的文本选项。"
        ),
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_ROOT),
        help="输出目录（会在其下创建按月份分组的子目录）",
    )
    return parser.parse_args()


def normalize_text(text: str) -> str:
    return WHITESPACE_RE.sub("", (text or "").strip())


def normalize_choice_text(text: str) -> str:
    """归一化文本选项用于评分匹配：去掉空白与常见标点并转小写。"""
    return CHOICE_PUNCT_RE.sub("", (text or "").strip()).lower()


def build_text_score_map(
    rubric: Iterable[Tuple[str, float]],
    base: Optional[Dict[str, float]] = None,
) -> Dict[str, float]:
    """把（文本, 分值）对构建为“归一化文本 -> 分值”的查表。

    若出现同一文本对应不同分值的冲突会直接报错，避免静默错配。
    """
    mapping: Dict[str, float] = dict(base or {})
    for answer, score in rubric:
        key = normalize_choice_text(answer)
        if not key:
            continue
        value = float(score)
        if key in mapping and mapping[key] != value:
            raise SystemExit(
                f"文本评分映射冲突：文本「{answer}」同时对应 {mapping[key]} 与 {value}"
            )
        mapping[key] = value
    return mapping


TEXT_SCORE_MAP: Dict[str, float] = build_text_score_map(TEXT_SCORE_RUBRIC)


def load_score_text_map(path: Optional[Path]) -> Dict[str, float]:
    """从 CSV 读取额外的“文本->分值”映射，并叠加在内置表之上。

    兼容用户提供的格式：每行可能是“分组标题行”（第二列为空），
    也可能是“答案,分值”行；只采纳第二列能解析为数字的行。
    """
    base = dict(TEXT_SCORE_MAP)
    if path is None:
        return base
    path = Path(path).expanduser()
    if not path.exists():
        raise SystemExit(f"文本评分映射文件不存在: {path}")

    extra: List[Tuple[str, float]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if len(row) < 2:
                continue
            answer = (row[0] or "").strip()
            score = parse_number(row[1])
            if not answer or score is None:
                continue
            extra.append((answer, score))
    return build_text_score_map(extra, base=base)


def parse_number(value: str) -> Optional[float]:
    raw = (value or "").strip().replace(",", "")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        matched = NUMBER_RE.search(raw)
        if not matched:
            return None
        try:
            return float(matched.group(0))
        except ValueError:
            return None


def parse_datetime(value: str) -> Optional[datetime]:
    raw = (value or "").strip()
    if not raw:
        return None
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def parse_date_boundary(value: Optional[str], *, end_of_day: bool = False) -> Optional[datetime]:
    raw = (value or "").strip()
    if not raw:
        return None

    dt = parse_datetime(raw)
    if dt is None:
        raise SystemExit(f"日期格式错误：{value}，应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM")

    # Pure date inputs use inclusive day boundaries.
    if end_of_day and len(raw) <= 10:
        return dt + timedelta(days=1)
    return dt


def parse_month_or_exit(month: str) -> str:
    if not MONTH_RE.match(month):
        raise SystemExit(f"--month 格式错误：{month}，应为 YYYY-MM")
    year = int(month[:4])
    mm = int(month[5:7])
    if mm < 1 or mm > 12:
        raise SystemExit(f"--month 非法月份：{month}")
    if year < 2000 or year > 2100:
        raise SystemExit(f"--month 年份超出预期：{month}")
    return month


def shift_month(month: str, offset: int) -> str:
    year = int(month[:4])
    mm = int(month[5:7])
    absolute = year * 12 + (mm - 1) + offset
    target_year, target_month_index = divmod(absolute, 12)
    return f"{target_year:04d}-{target_month_index + 1:02d}"


# 身份取值在新版问卷里变成了“学生本人”，这里归一化到统一口径，
# 保证身份筛选与“学生/家长”维度逻辑在新旧问卷上都成立。
IDENTITY_ALIASES = {
    "学生本人": "学生",
    "学生": "学生",
    "家长/监护人": "家长/监护人",
    "家长": "家长/监护人",
    "监护人": "家长/监护人",
}


def canonical_identity(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return "未知"
    return IDENTITY_ALIASES.get(text, text)


def parse_identity_filter(raw: str) -> Optional[set]:
    text = (raw or "").strip()
    if not text or text.lower() == "all":
        return None
    return {canonical_identity(x) for x in text.split(",") if x.strip()}


def parse_name_set(raw: str) -> set:
    text = (raw or "").strip()
    if not text:
        return set()
    return {normalize_text(x) for x in text.split(",") if normalize_text(x)}


def load_name_map(path: Path) -> Dict[str, Dict[str, str]]:
    mapping: Dict[str, Dict[str, str]] = {"teacher": {}, "student": {}}
    if not path.exists():
        return mapping

    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            entity = normalize_text(row.get("entity", "")).lower()
            raw = normalize_text(row.get("raw", "") or row.get("from", ""))
            normalized = normalize_text(row.get("normalized", "") or row.get("to", ""))
            if entity not in mapping:
                continue
            if not raw or not normalized:
                continue
            mapping[entity][raw] = normalized
    return mapping


def normalize_teacher(name: str, teacher_map: Dict[str, str]) -> str:
    text = normalize_text(name)
    if text.endswith("老师"):
        text = text[:-2]
    return teacher_map.get(text, text)


def normalize_student(name: str, student_map: Dict[str, str]) -> str:
    text = normalize_text(name)
    text = TRAILING_STUDENT_CODE_RE.sub("", text)
    return student_map.get(text, text)


def split_text_fragments(text: str) -> List[str]:
    if not text:
        return []
    return [x.strip() for x in TEXT_SPLIT_RE.split(text.strip()) if x.strip()]


def join_unique_texts(values: List[str], max_items: int = 8) -> str:
    seen = set()
    out: List[str] = []
    for value in values:
        for frag in split_text_fragments(value):
            if frag in seen:
                continue
            seen.add(frag)
            out.append(frag)
            if len(out) >= max_items:
                return " | ".join(out)
    return " | ".join(out)


def map_score_value(
    raw: str, score_map: Optional[Dict[str, float]] = None
) -> Optional[float]:
    """把一个原始单元格解析为分值：先查文本映射，再回退到数字解析。

    顺序很重要：先按文本表查，保证“文本选项”优先命中映射表；
    未命中再用数字解析，兼容老版纯数字以及“5分 − 高效回复”等带数字前缀文案。
    """
    text = (raw or "").strip()
    if not text:
        return None
    smap = score_map if score_map is not None else TEXT_SCORE_MAP
    key = normalize_choice_text(text)
    if key in smap:
        return smap[key]
    return parse_number(text)


def field_columns(field: Dict[str, object]) -> List[str]:
    """返回字段的候选列名：主列名 + 兼容旧版的别名。"""
    cols = [field["column"]]
    cols.extend(field.get("aliases", []) or [])
    return cols


def first_nonempty(row: Dict[str, str], columns: Iterable[str]) -> str:
    for col in columns:
        value = (row.get(col, "") or "").strip()
        if value:
            return value
    return ""


def extract_scores(
    row: Dict[str, str], score_map: Optional[Dict[str, float]] = None
) -> Dict[str, Optional[float]]:
    scores: Dict[str, Optional[float]] = {}
    for field in NUMERIC_SCORE_FIELDS:
        raw = first_nonempty(row, field_columns(field))
        scores[field["id"]] = map_score_value(raw, score_map)
    return scores


def collect_unmapped_score_texts(
    raw_feedback_records: List[Dict[str, object]],
    score_map: Optional[Dict[str, float]] = None,
) -> Dict[str, Dict[str, int]]:
    """找出评分列里“非空、既非数字、也没命中文本映射”的答案，便于人工补充映射。

    返回 {列名: {原始文本: 次数}}，用于告警与写入 run_meta，避免文本静默丢分。
    """
    smap = score_map if score_map is not None else TEXT_SCORE_MAP
    result: Dict[str, Counter] = defaultdict(Counter)
    for record in raw_feedback_records:
        row = record.get("raw_row") if isinstance(record, dict) else None
        if not isinstance(row, dict):
            continue
        for field in NUMERIC_SCORE_FIELDS:
            columns = field_columns(field)
            raw = first_nonempty(row, columns)
            if not raw:
                continue
            if normalize_choice_text(raw) in smap:
                continue
            if parse_number(raw) is not None:
                continue
            result[field["column"]][raw] += 1
    return {col: dict(counter) for col, counter in result.items()}


def analyze_org_fields(
    raw_feedback_records: List[Dict[str, object]],
) -> Dict[str, Dict[str, object]]:
    """统计机构层面字段（满意度、机构优势）的分布。

    这些是“机构满意度/机构优势”，不归属到具体老师，仅做整体分布单独分析。
    多选字段（如机构优势）按逗号拆分后分别计数。
    """
    analysis: Dict[str, Dict[str, object]] = {}
    for field in ORG_ANALYSIS_FIELDS:
        counter: Counter = Counter()
        respondents = 0
        for record in raw_feedback_records:
            row = record.get("raw_row") if isinstance(record, dict) else None
            if not isinstance(row, dict):
                continue
            raw = (row.get(field["column"], "") or "").strip()
            other = (row.get(field.get("other_column", ""), "") or "").strip()
            if not raw and not other:
                continue
            respondents += 1
            if field.get("kind") == "multi":
                parts = [p.strip() for p in re.split(r"[，,]", raw) if p.strip()]
                if other:
                    parts.append(other)
                for part in parts:
                    counter[part] += 1
            else:
                if raw:
                    counter[raw] += 1
        analysis[field["id"]] = {
            "label": field["label"],
            "respondent_count": respondents,
            "distribution": dict(counter.most_common()),
        }
    return analysis


def extract_text_feedback(row: Dict[str, str]) -> Dict[str, str]:
    text_feedback: Dict[str, str] = {}
    for field in TEXT_FEEDBACK_FIELDS:
        values = []
        for col in field["columns"]:
            text = (row.get(col, "") or "").strip()
            if text:
                values.append(text)
        text_feedback[field["id"]] = join_unique_texts(values, max_items=20)
    return text_feedback


def read_schedule(
    schedule_csv: Path,
    month: str,
    include_cancelled: bool,
    max_duration_hours: float,
    exclude_course_type_keywords: List[str],
    teacher_map: Dict[str, str],
    student_map: Dict[str, str],
) -> Tuple[
    Dict[str, float],
    Dict[Tuple[str, str], float],
    Dict[str, float],
    Dict[str, object],
]:
    teacher_total_hours: Dict[str, float] = defaultdict(float)
    teacher_student_hours: Dict[Tuple[str, str], float] = defaultdict(float)
    student_total_hours: Dict[str, float] = defaultdict(float)

    stats = {
        "schedule_rows_total": 0,
        "schedule_rows_in_month": 0,
        "schedule_rows_invalid_date": 0,
        "schedule_rows_cancelled_skipped": 0,
        "schedule_rows_invalid_duration": 0,
        "schedule_rows_missing_teacher_or_student": 0,
        "schedule_rows_filtered_course_type": 0,
        "schedule_rows_filtered_over_max_duration": 0,
        "cancel_value_counter": Counter(),
    }

    with schedule_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stats["schedule_rows_total"] += 1

            dt = parse_datetime(row.get("上课时间", "") or row.get("当地上课时间", ""))
            if dt is None:
                stats["schedule_rows_invalid_date"] += 1
                continue

            if dt.strftime("%Y-%m") != month:
                continue
            stats["schedule_rows_in_month"] += 1

            cancel_value = (row.get("临时取消", "") or "").strip()
            if cancel_value and not include_cancelled:
                stats["schedule_rows_cancelled_skipped"] += 1
                stats["cancel_value_counter"][cancel_value] += 1
                continue

            teacher = normalize_teacher(row.get("老师", ""), teacher_map)
            student = normalize_student(row.get("学生", ""), student_map)
            if not teacher or not student:
                stats["schedule_rows_missing_teacher_or_student"] += 1
                continue

            duration = parse_number(row.get("课程时长", ""))
            if duration is None or duration <= 0:
                stats["schedule_rows_invalid_duration"] += 1
                continue

            course_type = (row.get("课程类型", "") or "").strip()
            if course_type and any(k in course_type for k in exclude_course_type_keywords):
                stats["schedule_rows_filtered_course_type"] += 1
                continue

            if max_duration_hours > 0 and duration > max_duration_hours:
                stats["schedule_rows_filtered_over_max_duration"] += 1
                continue

            teacher_total_hours[teacher] += duration
            teacher_student_hours[(teacher, student)] += duration
            student_total_hours[student] += duration

    stats["teacher_count_in_month"] = len(teacher_total_hours)
    stats["student_count_in_month"] = len(student_total_hours)
    stats["total_teacher_hours"] = round(sum(teacher_total_hours.values()), 6)
    return teacher_total_hours, teacher_student_hours, student_total_hours, stats


def read_feedback_latest(
    feedback_csv: Path,
    month: str,
    identity_filter: Optional[set],
    teacher_map: Dict[str, str],
    student_map: Dict[str, str],
    feedback_month_offset: int = 1,
    feedback_start_date: Optional[str] = None,
    feedback_end_date: Optional[str] = None,
) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
    feedback_source_month = shift_month(month, feedback_month_offset)
    feedback_window_start = parse_date_boundary(feedback_start_date)
    feedback_window_end_exclusive = parse_date_boundary(
        feedback_end_date,
        end_of_day=True,
    )
    if (
        feedback_window_start is not None
        and feedback_window_end_exclusive is not None
        and feedback_window_start >= feedback_window_end_exclusive
    ):
        raise SystemExit("反馈时间窗口非法：start 必须早于 end")

    use_explicit_window = (
        feedback_window_start is not None or feedback_window_end_exclusive is not None
    )
    latest: Dict[Tuple[str, str, str], Dict[str, object]] = {}
    stats = {
        "feedback_rows_total": 0,
        "feedback_rows_in_month": 0,
        "feedback_rows_in_scope": 0,
        "feedback_rows_invalid_date": 0,
        "feedback_rows_filtered_identity": 0,
        "feedback_identity_counter": Counter(),
        "feedback_filter_mode": "date_range" if use_explicit_window else "source_month",
        "feedback_source_month": feedback_source_month if not use_explicit_window else "",
        "feedback_window_start": (
            feedback_window_start.strftime("%Y-%m-%d %H:%M:%S")
            if feedback_window_start is not None
            else ""
        ),
        "feedback_window_end": (
            (
                feedback_window_end_exclusive - timedelta(seconds=1)
            ).strftime("%Y-%m-%d %H:%M:%S")
            if feedback_window_end_exclusive is not None
            else ""
        ),
    }

    with feedback_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stats["feedback_rows_total"] += 1

            dt = parse_datetime(row.get("提交时间", ""))
            if dt is None:
                stats["feedback_rows_invalid_date"] += 1
                continue

            if use_explicit_window:
                if feedback_window_start is not None and dt < feedback_window_start:
                    continue
                if (
                    feedback_window_end_exclusive is not None
                    and dt >= feedback_window_end_exclusive
                ):
                    continue
            else:
                if dt.strftime("%Y-%m") != feedback_source_month:
                    continue
            stats["feedback_rows_in_month"] += 1
            stats["feedback_rows_in_scope"] += 1

            identity = canonical_identity(
                row.get("身份", "") or row.get("填写人身份", "")
            )
            if identity_filter is not None and identity not in identity_filter:
                stats["feedback_rows_filtered_identity"] += 1
                continue
            stats["feedback_identity_counter"][identity] += 1

            teacher_raw_name = row.get("老师姓名", "") or row.get("老师名", "")
            student_raw_name = row.get("学生姓名", "") or row.get("学员名", "")
            teacher = normalize_teacher(teacher_raw_name, teacher_map)
            student = normalize_student(student_raw_name, student_map)
            student_raw = (student_raw_name or "").strip()
            if not teacher or not student:
                continue

            key = (teacher, student, identity)
            current = latest.get(key)
            payload = {
                "teacher": teacher,
                "student": student,
                "student_raw": student_raw,
                "identity": identity,
                "submitted_at": dt,
                "submitted_at_raw": row.get("提交时间", ""),
                "raw_row": row,
            }
            if current is None or dt > current["submitted_at"]:
                latest[key] = payload

    records = list(latest.values())
    stats["feedback_latest_record_count"] = len(records)
    return records, stats


def merge_feedback_records(
    base_records: List[Dict[str, object]],
    combine_mode: str,
    score_map: Optional[Dict[str, float]] = None,
) -> List[FeedbackRecord]:
    with_scores = []
    for r in base_records:
        row = r["raw_row"]
        with_scores.append(
            FeedbackRecord(
                teacher=r["teacher"],
                student=r["student"],
                student_raw_name=r.get("student_raw", r["student"]),
                identity=r["identity"],
                source_identities=r["identity"],
                submitted_at=r["submitted_at"].strftime("%Y-%m-%d %H:%M:%S"),
                scores=extract_scores(row, score_map),
                text_feedback=extract_text_feedback(row),
            )
        )

    if combine_mode == "independent":
        return with_scores

    grouped: Dict[Tuple[str, str], List[FeedbackRecord]] = defaultdict(list)
    for rec in with_scores:
        grouped[(rec.teacher, rec.student)].append(rec)

    merged: List[FeedbackRecord] = []
    for (teacher, student), items in grouped.items():
        identities = sorted({x.identity for x in items})
        submitted_at = max(items, key=lambda x: x.submitted_at).submitted_at
        raw_name_counter = Counter(x.student_raw_name for x in items if x.student_raw_name)
        student_raw = raw_name_counter.most_common(1)[0][0] if raw_name_counter else student

        merged_scores: Dict[str, Optional[float]] = {}
        for field in NUMERIC_SCORE_FIELDS:
            score_id = field["id"]
            vals = [x.scores.get(score_id) for x in items if x.scores.get(score_id) is not None]
            merged_scores[score_id] = (sum(vals) / len(vals)) if vals else None

        merged_text_feedback: Dict[str, str] = {}
        for text_field in TEXT_FEEDBACK_FIELDS:
            text_id = text_field["id"]
            values = [x.text_feedback.get(text_id, "") for x in items]
            merged_text_feedback[text_id] = join_unique_texts(values, max_items=20)

        merged.append(
            FeedbackRecord(
                teacher=teacher,
                student=student,
                student_raw_name=student_raw,
                identity="合并",
                source_identities="|".join(identities),
                submitted_at=submitted_at,
                scores=merged_scores,
                text_feedback=merged_text_feedback,
            )
        )
    return merged


def apply_weights(
    records: List[FeedbackRecord],
    teacher_total_hours: Dict[str, float],
    teacher_student_hours: Dict[Tuple[str, str], float],
    student_total_hours: Dict[str, float],
) -> None:
    teacher_raw_weight_sum: Dict[str, float] = defaultdict(float)
    for rec in records:
        rec.teacher_total_hours = teacher_total_hours.get(rec.teacher, 0.0)
        rec.student_teacher_hours = teacher_student_hours.get((rec.teacher, rec.student), 0.0)
        rec.student_total_hours = student_total_hours.get(rec.student, 0.0)
        rec.raw_weight = (
            rec.student_teacher_hours / rec.teacher_total_hours
            if rec.teacher_total_hours > 0
            else 0.0
        )
        rec.matched = rec.raw_weight > 0
        if rec.matched:
            teacher_raw_weight_sum[rec.teacher] += rec.raw_weight

    for rec in records:
        denom = teacher_raw_weight_sum.get(rec.teacher, 0.0)
        rec.normalized_weight = (rec.raw_weight / denom) if denom > 0 else 0.0


def metric_value_from_record(rec: FeedbackRecord, score_ids: List[str]) -> Optional[float]:
    vals = [rec.scores.get(score_id) for score_id in score_ids if rec.scores.get(score_id) is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


def metric_value_from_records(records: List[FeedbackRecord], score_ids: List[str]) -> Optional[float]:
    vals = [metric_value_from_record(rec, score_ids) for rec in records]
    nonnull = [x for x in vals if x is not None]
    if not nonnull:
        return None
    return sum(nonnull) / len(nonnull)


def filter_excluded_teachers(
    records: List[FeedbackRecord],
    teacher_total_hours: Dict[str, float],
    teacher_student_hours: Dict[Tuple[str, str], float],
    raw_feedback_records: List[Dict[str, object]],
    excluded_teachers: set,
) -> Dict[str, object]:
    if not excluded_teachers:
        return {
            "records": records,
            "teacher_total_hours": teacher_total_hours,
            "teacher_student_hours": teacher_student_hours,
            "raw_feedback_records": raw_feedback_records,
        }

    return {
        "records": [r for r in records if r.teacher not in excluded_teachers],
        "teacher_total_hours": {
            teacher: hours
            for teacher, hours in teacher_total_hours.items()
            if teacher not in excluded_teachers
        },
        "teacher_student_hours": {
            (teacher, student): hours
            for (teacher, student), hours in teacher_student_hours.items()
            if teacher not in excluded_teachers
        },
        "raw_feedback_records": [
            r for r in raw_feedback_records if r["teacher"] not in excluded_teachers
        ],
    }


def build_teacher_summary(
    records: List[FeedbackRecord],
    teacher_total_hours: Dict[str, float],
    teacher_student_hours: Dict[Tuple[str, str], float],
    raw_feedback_records: List[Dict[str, object]],
) -> List[Dict[str, object]]:
    records_by_teacher: Dict[str, List[FeedbackRecord]] = defaultdict(list)
    records_by_teacher_student: Dict[Tuple[str, str], List[FeedbackRecord]] = defaultdict(list)
    responded_students_by_teacher: Dict[str, set] = defaultdict(set)
    raw_records_by_teacher: Dict[str, List[Dict[str, object]]] = defaultdict(list)

    for rec in records:
        records_by_teacher[rec.teacher].append(rec)
        records_by_teacher_student[(rec.teacher, rec.student)].append(rec)
        if rec.matched:
            responded_students_by_teacher[rec.teacher].add(rec.student)
    for rec in raw_feedback_records:
        raw_records_by_teacher[rec["teacher"]].append(rec)

    month_metric_avg: Dict[str, Optional[float]] = {}
    for metric in METRIC_VIEWS:
        for variant in metric["variants"]:
            metric_prefix = f"metric_{metric['id']}_{variant['id']}"
            num = 0.0
            den = 0.0
            for (teacher, student), student_records in records_by_teacher_student.items():
                total_hours = teacher_total_hours.get(teacher, 0.0)
                student_hours = teacher_student_hours.get((teacher, student), 0.0)
                if total_hours <= 0 or student_hours <= 0:
                    continue
                score = metric_value_from_records(
                    [rec for rec in student_records if rec.matched],
                    variant["score_ids"],
                )
                if score is None:
                    continue
                weight = student_hours / total_hours
                num += score * weight
                den += weight
            month_metric_avg[metric_prefix] = (num / den) if den > 0 else None

    teachers = sorted(set(teacher_total_hours.keys()) | set(records_by_teacher.keys()))
    summary_rows: List[Dict[str, object]] = []

    for teacher in teachers:
        total_hours = teacher_total_hours.get(teacher, 0.0)
        teacher_records = records_by_teacher.get(teacher, [])
        matched_records = [r for r in teacher_records if r.matched]
        teacher_raw_records = raw_records_by_teacher.get(teacher, [])
        matched_raw_records = [
            r
            for r in teacher_raw_records
            if teacher_student_hours.get((r["teacher"], r["student"]), 0.0) > 0
        ]

        responded_students = responded_students_by_teacher.get(teacher, set())
        responded_hours = sum(
            teacher_student_hours.get((teacher, stu), 0.0) for stu in responded_students
        )
        coverage_rate = (responded_hours / total_hours) if total_hours > 0 else 0.0

        row: Dict[str, object] = {
            "teacher": teacher,
            "teacher_total_hours": round(total_hours, 6),
            "response_record_count": len(teacher_raw_records),
            "matched_response_record_count": len(matched_raw_records),
            "merged_response_record_count": len(teacher_records),
            "matched_merged_response_record_count": len(matched_records),
            "responded_student_count": len(responded_students),
            "responded_hours_distinct_students": round(responded_hours, 6),
            "coverage_rate": round(coverage_rate, 6),
            "raw_weight_sum": round(sum(r.raw_weight for r in matched_records), 6),
            "normalized_weight_sum": round(
                sum(r.normalized_weight for r in matched_records), 6
            ),
        }

        for metric in METRIC_VIEWS:
            for variant in metric["variants"]:
                metric_prefix = f"metric_{metric['id']}_{variant['id']}"
                raw_num = 0.0
                raw_den = 0.0
                norm_num = 0.0
                norm_den = 0.0
                value_count = 0
                metric_fill_value = month_metric_avg.get(metric_prefix)

                for (rec_teacher, student), student_hours in teacher_student_hours.items():
                    if rec_teacher != teacher or student_hours <= 0 or total_hours <= 0:
                        continue

                    score = metric_value_from_records(
                        [rec for rec in records_by_teacher_student.get((teacher, student), []) if rec.matched],
                        variant["score_ids"],
                    )
                    if score is not None:
                        value_count += 1
                    else:
                        score = metric_fill_value

                    if score is None:
                        continue

                    weight = student_hours / total_hours
                    raw_num += score * weight
                    raw_den += weight
                    norm_num += score * weight
                    norm_den += weight

                raw_avg = (raw_num / raw_den) if raw_den > 0 else None
                norm_avg = (norm_num / norm_den) if norm_den > 0 else None

                row[f"{metric_prefix}_label"] = f"{metric['label']}-{variant['label']}"
                row[f"{metric_prefix}_description"] = metric["description"]
                row[f"{metric_prefix}_scale_max"] = metric["scale_max"]
                row[f"{metric_prefix}_value_count"] = value_count
                row[f"{metric_prefix}_raw_avg"] = (
                    round(raw_avg, 6) if raw_avg is not None else ""
                )
                row[f"{metric_prefix}_normalized_avg"] = (
                    round(norm_avg, 6) if norm_avg is not None else ""
                )

        for text_field in TEXT_FEEDBACK_FIELDS:
            text_id = text_field["id"]
            all_values = [r.text_feedback.get(text_id, "") for r in teacher_records]
            matched_values = [r.text_feedback.get(text_id, "") for r in matched_records]

            all_nonempty = [x for x in all_values if x.strip()]
            matched_nonempty = [x for x in matched_values if x.strip()]

            row[f"text_{text_id}_label"] = text_field["label"]
            row[f"text_{text_id}_description"] = text_field["description"]
            row[f"text_{text_id}_count_all"] = len(all_nonempty)
            row[f"text_{text_id}_count_matched"] = len(matched_nonempty)
            row[f"text_{text_id}_samples_all"] = join_unique_texts(all_nonempty, max_items=3)
            row[f"text_{text_id}_samples_matched"] = join_unique_texts(
                matched_nonempty, max_items=3
            )

        summary_rows.append(row)

    return summary_rows


def build_teacher_text_feedback_rows(summary_rows: List[Dict[str, object]]) -> List[Dict[str, object]]:
    rows = []
    for row in summary_rows:
        out = {
            "teacher": row["teacher"],
        }
        for text_field in TEXT_FEEDBACK_FIELDS:
            text_id = text_field["id"]
            out[f"{text_id}_count_all"] = row.get(f"text_{text_id}_count_all", 0)
            out[f"{text_id}_count_matched"] = row.get(f"text_{text_id}_count_matched", 0)
            out[f"{text_id}_samples_all"] = row.get(f"text_{text_id}_samples_all", "")
            out[f"{text_id}_samples_matched"] = row.get(
                f"text_{text_id}_samples_matched", ""
            )
        rows.append(out)
    return rows


# 精简版“老师 -> 各指标加权分”导出。默认取每个指标的“总”维度加权分（normalized_avg），
# 与看板“总”口径一致；包含均分补齐逻辑（见 build_teacher_summary）。
TEACHER_SCORE_EXPORT_METRICS = [
    ("learning_effect", "学习提升效果"),
    ("responsibility", "责任心与服务态度"),
    ("charisma", "个人魅力"),
]


def build_teacher_score_table(
    summary_rows: List[Dict[str, object]],
) -> Tuple[List[Dict[str, object]], List[str]]:
    fieldnames = ["老师"] + [label for _, label in TEACHER_SCORE_EXPORT_METRICS]
    rows: List[Dict[str, object]] = []
    for row in summary_rows:
        out: Dict[str, object] = {"老师": row["teacher"]}
        for metric_id, label in TEACHER_SCORE_EXPORT_METRICS:
            value = row.get(f"metric_{metric_id}_total_normalized_avg", "")
            out[label] = round(float(value), 2) if value not in ("", None) else ""
        rows.append(out)
    return rows, fieldnames


def write_csv(path: Path, rows: List[Dict[str, object]], fieldnames: Iterable[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(fieldnames), extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def build_dashboard_metric_catalog() -> List[Dict[str, object]]:
    catalog = []
    for metric in METRIC_VIEWS:
        variants = []
        for variant in metric["variants"]:
            prefix = f"metric_{metric['id']}_{variant['id']}"
            variants.append(
                {
                    "id": variant["id"],
                    "label": variant["label"],
                    "value_key": f"{prefix}_normalized_avg",
                    "count_key": f"{prefix}_value_count",
                    "score_ids": variant.get("score_ids", []),
                }
            )
        catalog.append(
            {
                "id": metric["id"],
                "label": metric["label"],
                "description": metric["description"],
                "scaleMax": metric["scale_max"],
                "isPercent": False,
                "variants": variants,
            }
        )

    catalog.append(
        {
            "id": COVERAGE_METRIC["id"],
            "label": COVERAGE_METRIC["label"],
            "description": COVERAGE_METRIC["description"],
            "scaleMax": COVERAGE_METRIC["scale_max"],
            "isPercent": True,
            "variants": [
                {
                    "id": "total",
                    "label": "总",
                    "value_key": "coverage_rate",
                    "count_key": "matched_response_record_count",
                    "score_ids": [],
                }
            ],
        }
    )
    return catalog


def coerce_float(value: object) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def compute_chart_highlight_flags(
    values: List[float], scale_max: float, is_percent: bool
) -> List[bool]:
    highlight_count = (len(values) + 1) // 2
    default_flags = [idx < highlight_count for idx in range(len(values))]
    if is_percent or scale_max != 5 or not values:
        return default_flags

    full_score_count = sum(1 for value in values if abs(value - scale_max) < 1e-9)
    if full_score_count > len(values) / 2:
        return [abs(value - scale_max) < 1e-9 for value in values]
    return default_flags


def write_dashboard_html(
    path: Path,
    month: str,
    summary_rows: List[Dict[str, object]],
    feedback_records: List[FeedbackRecord],
    detail_rows_override: Optional[List[Dict[str, object]]] = None,
) -> None:
    rows = []
    for row in summary_rows:
        payload_row = {
            "teacher": row.get("teacher"),
            "teacher_total_hours": row.get("teacher_total_hours", 0),
            "coverage_rate": row.get("coverage_rate", 0),
            "response_record_count": row.get("response_record_count", 0),
            "matched_response_record_count": row.get("matched_response_record_count", 0),
            "responded_student_count": row.get("responded_student_count", 0),
        }

        for metric in METRIC_VIEWS:
            for variant in metric["variants"]:
                prefix = f"metric_{metric['id']}_{variant['id']}"
                payload_row[f"{prefix}_normalized_avg"] = row.get(
                    f"{prefix}_normalized_avg", ""
                )
                payload_row[f"{prefix}_value_count"] = row.get(f"{prefix}_value_count", 0)

        for text_field in TEXT_FEEDBACK_FIELDS:
            text_id = text_field["id"]
            payload_row[f"text_{text_id}_count_all"] = row.get(
                f"text_{text_id}_count_all", 0
            )
            payload_row[f"text_{text_id}_count_matched"] = row.get(
                f"text_{text_id}_count_matched", 0
            )
            payload_row[f"text_{text_id}_samples_all"] = row.get(
                f"text_{text_id}_samples_all", ""
            )

        rows.append(payload_row)

    detail_fieldnames = [
        "teacher",
        "student",
        "student_raw_name",
        "student_teacher_hours",
        "matched",
        *(f"score_{field['id']}" for field in NUMERIC_SCORE_FIELDS),
    ]
    if detail_rows_override is not None:
        detail_rows = [
            {fieldname: row.get(fieldname, "") for fieldname in detail_fieldnames}
            for row in detail_rows_override
        ]
    else:
        detail_rows = []
        for rec in feedback_records:
            payload_detail = {
                "teacher": rec.teacher,
                "student": rec.student,
                "student_raw_name": rec.student_raw_name,
                "student_teacher_hours": rec.student_teacher_hours,
                "matched": int(rec.matched),
            }
            for field in NUMERIC_SCORE_FIELDS:
                score_id = field["id"]
                payload_detail[f"score_{score_id}"] = (
                    rec.scores.get(score_id)
                    if rec.scores.get(score_id) is not None
                    else ""
                )
            detail_rows.append(payload_detail)

    metric_catalog = build_dashboard_metric_catalog()
    text_catalog = [
        {
            "id": f["id"],
            "label": f["label"],
            "description": f["description"],
        }
        for f in TEXT_FEEDBACK_FIELDS
    ]

    rows_payload = json.dumps(rows, ensure_ascii=False)
    detail_rows_payload = json.dumps(detail_rows, ensure_ascii=False)
    metrics_payload = json.dumps(metric_catalog, ensure_ascii=False)
    text_payload = json.dumps(text_catalog, ensure_ascii=False)

    data_dict_items = []
    for metric in metric_catalog:
        variants = " / ".join(v["label"] for v in metric["variants"])
        unit = "百分比" if metric["isPercent"] else f"分值（上限 {metric['scaleMax']}）"
        data_dict_items.append(
            {
                "name": metric["label"],
                "description": metric["description"],
                "variants": variants,
                "unit": unit,
            }
        )
    data_dict_payload = json.dumps(data_dict_items, ensure_ascii=False)

    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{month} 老师反馈加权看板</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {{
      --background: 210 33% 99%;
      --foreground: 222.2 47.4% 11.2%;
      --muted: 210 35% 95%;
      --muted-foreground: 215 18% 40%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 47.4% 11.2%;
      --border: 214 30% 88%;
      --primary: 217.2 91.2% 59.8%;
      --primary-foreground: 210 40% 98%;
      --radius: 0.75rem;
    }}

    * {{ box-sizing: border-box; }}

    body {{
      margin: 0;
      color: hsl(var(--foreground));
      background:
        radial-gradient(circle at 0% 0%, rgba(59,130,246,.10), transparent 34%),
        radial-gradient(circle at 100% 0%, rgba(14,165,233,.06), transparent 28%),
        hsl(var(--background));
      font-family: "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
    }}

    .wrap {{
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 16px 48px;
    }}

    .title {{
      margin: 0;
      font-size: 28px;
      letter-spacing: -0.02em;
      font-weight: 700;
    }}

    .subtitle {{
      margin: 8px 0 20px;
      color: hsl(var(--muted-foreground));
      font-size: 14px;
      line-height: 1.6;
    }}

    .card {{
      background: hsl(var(--card));
      color: hsl(var(--card-foreground));
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.045), 0 2px 8px rgba(15, 23, 42, 0.03);
      padding: 16px;
      margin-bottom: 16px;
    }}

    .chart-card {{
      border-color: rgba(59, 130, 246, 0.24);
      box-shadow: 0 18px 44px rgba(37, 99, 235, 0.12), 0 6px 18px rgba(15, 23, 42, 0.05);
      background: linear-gradient(180deg, rgba(255,255,255,0.99), rgba(247,250,255,0.96));
    }}

    .tabs {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }}

    .tab-btn {{
      border: 1px solid hsl(var(--border));
      background: hsl(var(--background));
      color: hsl(var(--muted-foreground));
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.16s ease;
    }}

    .tab-btn:hover {{
      border-color: rgba(59, 130, 246, 0.28);
      color: hsl(var(--foreground));
      background: rgba(255,255,255,0.92);
    }}

    .tab-btn.active {{
      background: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      border-color: hsl(var(--primary));
      box-shadow: 0 6px 18px rgba(37, 99, 235, 0.18);
    }}

    .metric-name {{
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }}

    .chart-card .metric-name {{
      font-size: 20px;
      letter-spacing: -0.01em;
    }}

    .metric-desc {{
      margin: 6px 0 12px;
      color: hsl(var(--muted-foreground));
      font-size: 13px;
      line-height: 1.5;
    }}

    .chart-wrap {{
      height: 520px;
    }}

    .chart-card .chart-wrap {{
      height: 560px;
      margin-top: 6px;
      padding: 16px 12px 6px;
      border: 1px solid rgba(59, 130, 246, 0.14);
      border-radius: calc(var(--radius) - 2px);
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(239,246,255,0.90));
    }}

    .badge-row {{
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }}

    .badge {{
      font-size: 12px;
      padding: 4px 10px;
      border: 1px solid hsl(var(--border));
      border-radius: 999px;
      color: hsl(var(--muted-foreground));
      background: rgba(248, 250, 252, 0.95);
    }}

    .teacher-filter-toolbar {{
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin: 4px 0 10px;
    }}

    .teacher-filter-menu {{
      position: relative;
      z-index: 20;
    }}

    .teacher-filter-menu > summary {{
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 34px;
      padding: 6px 11px;
      border: 1px solid hsl(var(--border));
      border-radius: 9px;
      color: hsl(var(--muted-foreground));
      background: rgba(255, 255, 255, 0.96);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      list-style: none;
      transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
    }}

    .teacher-filter-menu > summary::-webkit-details-marker {{ display: none; }}

    .teacher-filter-menu > summary:hover,
    .teacher-filter-menu[open] > summary {{
      border-color: rgba(59, 130, 246, 0.42);
      color: hsl(var(--foreground));
      background: rgba(239, 246, 255, 0.98);
    }}

    .teacher-filter-count {{
      display: inline-grid;
      place-items: center;
      min-width: 19px;
      height: 19px;
      padding: 0 5px;
      border-radius: 999px;
      color: white;
      background: hsl(var(--primary));
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }}

    .teacher-filter-count:empty {{ display: none; }}

    .teacher-filter-chevron {{
      transition: transform 0.18s ease;
    }}

    .teacher-filter-menu[open] .teacher-filter-chevron {{
      transform: rotate(180deg);
    }}

    .teacher-filter-popover {{
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      width: min(520px, calc(100vw - 64px));
      padding: 14px;
      border: 1px solid rgba(59, 130, 246, 0.2);
      border-radius: 13px;
      background: rgba(255, 255, 255, 0.99);
      box-shadow: 0 20px 48px rgba(30, 64, 175, 0.17), 0 4px 12px rgba(15, 23, 42, 0.08);
    }}

    .teacher-filter-popover-head,
    .teacher-filter-popover-foot {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }}

    .teacher-filter-title {{
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }}

    .teacher-filter-summary {{
      margin: 0;
      color: hsl(var(--muted-foreground));
      font-size: 11px;
    }}

    .teacher-filter-search {{
      width: 100%;
      margin: 11px 0 8px;
      padding: 8px 10px;
      border: 1px solid hsl(var(--border));
      border-radius: 8px;
      color: hsl(var(--foreground));
      background: rgba(248, 250, 252, 0.86);
      font: inherit;
      font-size: 12px;
      outline: none;
    }}

    .teacher-filter-search:focus {{
      border-color: rgba(59, 130, 246, 0.58);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }}

    .teacher-filter-clear {{
      border: 0;
      padding: 4px;
      color: hsl(var(--primary));
      background: transparent;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }}

    .teacher-filter-clear:disabled {{
      color: hsl(var(--muted-foreground));
      cursor: default;
      opacity: 0.55;
    }}

    .teacher-filter-list {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px 8px;
      max-height: 250px;
      overflow: auto;
      padding: 2px;
    }}

    .teacher-filter-option {{
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      padding: 6px 8px;
      border-radius: 7px;
      color: hsl(var(--foreground));
      font-size: 12px;
      cursor: pointer;
    }}

    .teacher-filter-option:hover {{
      background: rgba(219, 234, 254, 0.7);
    }}

    .teacher-filter-option span {{
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}

    .teacher-filter-option small {{
      margin-left: auto;
      color: hsl(var(--muted-foreground));
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }}

    .teacher-filter-popover-foot {{
      margin-top: 9px;
      padding-top: 9px;
      border-top: 1px solid hsl(var(--border));
    }}

    .excluded-teacher-chips {{
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }}

    .excluded-teacher-chip {{
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 30px;
      padding: 5px 9px;
      border: 0;
      border-radius: 8px;
      color: rgba(30, 64, 175, 0.92);
      background: rgba(219, 234, 254, 0.72);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }}

    .excluded-teacher-chip:hover {{
      background: rgba(191, 219, 254, 0.82);
    }}

    .excluded-teacher-more {{
      color: hsl(var(--muted-foreground));
      font-size: 11px;
    }}

    @media (max-width: 640px) {{
      .teacher-filter-menu {{ width: 100%; }}
      .teacher-filter-menu > summary {{ width: 100%; justify-content: space-between; }}
      .teacher-filter-popover {{
        position: static;
        width: 100%;
        margin-top: 8px;
      }}
      .teacher-filter-list {{ grid-template-columns: 1fr; }}
    }}

    table {{
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 12px;
    }}

    th, td {{
      text-align: left;
      border-bottom: 1px solid hsl(var(--border));
      padding: 8px 6px;
      vertical-align: top;
    }}

    th {{
      background: rgba(241, 245, 249, 0.98);
      color: hsl(var(--foreground));
      position: sticky;
      top: 0;
    }}

    tbody tr:hover {{
      background: rgba(248, 250, 252, 0.88);
    }}

    .table-scroll {{
      max-height: 520px;
      overflow: auto;
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) - 2px);
    }}

    .table-scroll-expanded {{
      max-height: none;
      overflow: visible;
    }}

    .dict-item {{
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) - 2px);
      padding: 10px;
      margin-bottom: 8px;
      background: hsl(var(--background));
    }}

    .dict-name {{
      margin: 0 0 4px;
      font-size: 14px;
      font-weight: 600;
    }}

    .dict-meta {{
      margin: 0;
      font-size: 12px;
      color: hsl(var(--muted-foreground));
      line-height: 1.5;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">{month} 老师反馈加权看板</h1>
    <p class="subtitle">
      评分口径：按“学员在该老师课时 / 老师总课时”加权；图表按当前指标展示分值从高到低排序，展示分值相同则按老师总课时从高到低排序。<br/>
      覆盖率口径：有有效匹配反馈的去重学员课时 / 老师总课时。<br/>
      均值口径：仅统计当前指标有有效样本的老师，并按“老师总课时”加权平均。
    </p>

    <div class="card chart-card">
      <div class="tabs" id="metricTabs"></div>
      <h3 class="metric-name" id="metricName"></h3>
      <p class="metric-desc" id="metricDesc"></p>
      <div class="tabs" id="variantTabs"></div>
      <div class="teacher-filter-toolbar">
        <details class="teacher-filter-menu" id="teacherFilterMenu">
          <summary>
            <span>筛选老师</span>
            <span class="teacher-filter-count" id="teacherFilterCount"></span>
            <span class="teacher-filter-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="teacher-filter-popover">
            <div class="teacher-filter-popover-head">
              <h4 class="teacher-filter-title">排除老师</h4>
              <button id="clearTeacherFilter" class="teacher-filter-clear" type="button">清空</button>
            </div>
            <input id="teacherFilterSearch" class="teacher-filter-search" type="search" placeholder="搜索老师姓名" aria-label="搜索老师姓名" />
            <div class="teacher-filter-list" id="teacherFilterList"></div>
            <div class="teacher-filter-popover-foot">
              <p class="teacher-filter-summary" id="teacherFilterSummary"></p>
              <span class="teacher-filter-summary">勾选即排除</span>
            </div>
          </div>
        </details>
        <div class="excluded-teacher-chips" id="excludedTeacherChips"></div>
      </div>
      <div class="badge-row" id="metricMeta"></div>
      <div class="chart-wrap"><canvas id="metricChart"></canvas></div>
      <p id="chartFallback" class="metric-desc" style="display:none;margin-top:8px;">
        图表库未加载，仅显示下方排序表格数据。
      </p>
      <details style="margin-top: 10px;">
        <summary style="cursor:pointer;color:hsl(var(--muted-foreground));font-size:13px;">查看指标说明</summary>
        <div id="dictBox" style="margin-top:10px;"></div>
      </details>
    </div>

    <div class="card">
      <h3 class="metric-name">当前指标明细（按分值降序）</h3>
      <div class="table-scroll">
        <table id="metricTable"></table>
      </div>
    </div>

    <div class="card">
      <h3 class="metric-name">文本反馈概览（改进建议 / 推荐理由）</h3>
      <p class="metric-desc">统计口径为当月该老师收到的反馈条数，包含样例文本（最多 3 条）。</p>
      <div class="table-scroll table-scroll-expanded">
        <table id="textTable"></table>
      </div>
    </div>
  </div>

  <script>
    const rows = {rows_payload};
    const detailRows = {detail_rows_payload};
    const metrics = {metrics_payload};
    const textCatalog = {text_payload};
    const dictItems = {data_dict_payload};

    const metricTabs = document.getElementById("metricTabs");
    const variantTabs = document.getElementById("variantTabs");
    const metricName = document.getElementById("metricName");
    const metricDesc = document.getElementById("metricDesc");
    const metricMeta = document.getElementById("metricMeta");
    const dictBox = document.getElementById("dictBox");
    const metricTable = document.getElementById("metricTable");
    const textTable = document.getElementById("textTable");
    const teacherFilterMenu = document.getElementById("teacherFilterMenu");
    const teacherFilterCount = document.getElementById("teacherFilterCount");
    const teacherFilterSummary = document.getElementById("teacherFilterSummary");
    const teacherFilterSearch = document.getElementById("teacherFilterSearch");
    const teacherFilterList = document.getElementById("teacherFilterList");
    const clearTeacherFilter = document.getElementById("clearTeacherFilter");
    const excludedTeacherChips = document.getElementById("excludedTeacherChips");

    let currentMetricId = metrics[0]?.id;
    let currentVariantId = metrics[0]?.variants?.[0]?.id;
    const allTeachers = rows
      .map(r => ({{ teacher: r.teacher, totalHours: toNumber(r.teacher_total_hours) ?? 0 }}))
      .sort((a, b) => String(a.teacher).localeCompare(String(b.teacher), "zh-Hans-CN"));
    const excludedTeachers = new Set();

    function toNumber(v) {{
      if (v === null || v === undefined) return null;
      if (typeof v === "string" && v.trim() === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }}

    const chartCanvas = document.getElementById("metricChart");
    const chartFallback = document.getElementById("chartFallback");
    let chart = null;

    function trimFixed(value, digits) {{
      return Number(value).toFixed(digits).replace(/\\.?0+$/, "");
    }}

    function formatChartValue(metric, value) {{
      if (value === null || value === undefined) return "";
      if (metric.isPercent) return `${{trimFixed(value, 1)}}%`;
      return trimFixed(value, 3);
    }}

    function computeChartHighlightFlags(metric, topRows) {{
      const highlightCount = Math.ceil(topRows.length * 0.5);
      const defaultFlags = topRows.map((_, idx) => idx < highlightCount);
      if (metric.isPercent || metric.scaleMax !== 5 || topRows.length === 0) {{
        return defaultFlags;
      }}

      const fullScoreCount = topRows.filter(
        row => Math.abs(row.value - metric.scaleMax) < 1e-9
      ).length;
      if (fullScoreCount > topRows.length / 2) {{
        return topRows.map(
          row => Math.abs(row.value - metric.scaleMax) < 1e-9
        );
      }}
      return defaultFlags;
    }}

    const barValueLabelPlugin = {{
      id: "barValueLabelPlugin",
      afterDatasetsDraw(chartInstance) {{
        const {{ ctx }} = chartInstance;
        chartInstance.data.datasets.forEach((dataset, datasetIndex) => {{
          const meta = chartInstance.getDatasetMeta(datasetIndex);
          if (meta.hidden) return;
          meta.data.forEach((bar, index) => {{
            const label = dataset.valueLabels?.[index];
            if (!label) return;
            const position = bar.tooltipPosition();
            ctx.save();
            ctx.font = '700 12px "Inter", "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText(label, position.x, position.y - 6);
            ctx.restore();
          }});
        }});
      }}
    }};

    function getChart() {{
      if (chart) return chart;
      if (typeof Chart === "undefined") {{
        chartFallback.style.display = "block";
        return null;
      }}
      chartFallback.style.display = "none";
      chart = new Chart(chartCanvas, {{
        type: "bar",
        plugins: [barValueLabelPlugin],
        data: {{ labels: [], datasets: [{{ label: "", data: [], backgroundColor: "rgba(29, 78, 216, 0.84)", borderColor: "rgba(30, 64, 175, 1)", borderWidth: 1.25, borderRadius: 8, borderSkipped: false }}] }},
        options: {{
          responsive: true,
          maintainAspectRatio: false,
          layout: {{
            padding: {{
              top: 28,
              right: 8
            }}
          }},
          plugins: {{
            legend: {{ display: false }},
            tooltip: {{
              backgroundColor: "rgba(255,255,255,0.98)",
              titleColor: "rgba(15,23,42,0.96)",
              bodyColor: "rgba(30,41,59,0.9)",
              borderColor: "rgba(148,163,184,0.25)",
              borderWidth: 1,
              padding: 10,
              callbacks: {{
                afterLabel(context) {{
                  const counts = context.dataset.feedbackCounts || [];
                  const count = counts[context.dataIndex];
                  const totalHours = context.dataset.totalHours || [];
                  const hours = totalHours[context.dataIndex];
                  const lines = [];
                  if (count !== null && count !== undefined) {{
                    lines.push(`反馈数:${{count}}`);
                  }}
                  if (hours !== null && hours !== undefined) {{
                    lines.push(`课时总数:${{formatHours(hours)}}h`);
                  }}
                  return lines;
                }}
              }}
            }}
          }},
          scales: {{
            x: {{
              grid: {{ display: false }},
              ticks: {{
                color: "rgba(71, 85, 105, 0.92)",
                font: {{ size: 11 }},
                maxRotation: 45,
                minRotation: 0
              }}
            }},
            y: {{
              beginAtZero: true,
              ticks: {{
                color: "rgba(71, 85, 105, 0.92)"
              }},
              grid: {{
                color: "rgba(148, 163, 184, 0.22)"
              }}
            }}
          }}
        }}
      }});
      return chart;
    }}

    function renderDict() {{
      dictBox.innerHTML = dictItems.map(item => `
        <div class="dict-item">
          <p class="dict-name">${{item.name}}</p>
          <p class="dict-meta">${{item.description}}</p>
          <p class="dict-meta">维度：${{item.variants}} | 单位：${{item.unit}}</p>
        </div>
      `).join("");
    }}

    function renderMetricTabs() {{
      metricTabs.innerHTML = metrics.map(m => `
        <button class="tab-btn ${{m.id === currentMetricId ? "active" : ""}}" data-metric-id="${{m.id}}">${{m.label}}</button>
      `).join("");

      metricTabs.querySelectorAll("button[data-metric-id]").forEach(btn => {{
        btn.addEventListener("click", () => {{
          currentMetricId = btn.getAttribute("data-metric-id");
          const metric = metrics.find(m => m.id === currentMetricId);
          currentVariantId = metric?.variants?.[0]?.id || "total";
          renderAll();
        }});
      }});
    }}

    function renderVariantTabs(metric) {{
      variantTabs.innerHTML = metric.variants.map(v => `
        <button class="tab-btn ${{v.id === currentVariantId ? "active" : ""}}" data-variant-id="${{v.id}}">${{v.label}}</button>
      `).join("");

      variantTabs.querySelectorAll("button[data-variant-id]").forEach(btn => {{
        btn.addEventListener("click", () => {{
          currentVariantId = btn.getAttribute("data-variant-id");
          renderAll();
        }});
      }});
    }}

    function formatValue(metric, value) {{
      if (value === null) return "";
      if (metric.isPercent) return `${{value.toFixed(1)}}%`;
      return value.toFixed(3);
    }}

    function formatHours(v) {{
      if (v === null) return "";
      const fixed = Number(v).toFixed(2);
      return fixed.replace(/\\.00$/, "").replace(/(\\.\\d)0$/, "$1");
    }}

    function getVisibleRows() {{
      return rows.filter(r => !excludedTeachers.has(r.teacher));
    }}

    function updateTeacherFilterSummary() {{
      const excludedCount = excludedTeachers.size;
      teacherFilterCount.textContent = excludedCount > 0 ? String(excludedCount) : "";
      clearTeacherFilter.disabled = excludedCount === 0;
      teacherFilterSummary.textContent = `已排除 ${{excludedCount}} 位 · 展示 ${{allTeachers.length - excludedCount}} 位`;

      const excludedNames = allTeachers
        .map(entry => entry.teacher)
        .filter(teacher => excludedTeachers.has(teacher));
      const visibleChips = excludedNames.slice(0, 3);
      excludedTeacherChips.innerHTML = visibleChips.map(teacher => `
        <button class="excluded-teacher-chip" type="button" data-remove-excluded-teacher="${{teacher}}" title="恢复展示 ${{teacher}}">
          <span>${{teacher}}</span><span aria-hidden="true">×</span>
        </button>
      `).join("") + (excludedNames.length > 3
        ? `<span class="excluded-teacher-more">另 ${{excludedNames.length - 3}} 位</span>`
        : "");

      excludedTeacherChips.querySelectorAll("[data-remove-excluded-teacher]").forEach(button => {{
        button.addEventListener("click", () => {{
          const teacher = button.getAttribute("data-remove-excluded-teacher");
          if (!teacher) return;
          excludedTeachers.delete(teacher);
          renderTeacherFilter();
          renderAll();
        }});
      }});
    }}

    function applyTeacherFilterSearch() {{
      const keyword = teacherFilterSearch.value.trim().toLocaleLowerCase();
      teacherFilterList.querySelectorAll("[data-teacher-filter-option]").forEach(option => {{
        const teacher = option.getAttribute("data-teacher-filter-option") || "";
        option.hidden = keyword !== "" && !teacher.toLocaleLowerCase().includes(keyword);
      }});
    }}

    function renderTeacherFilter() {{
      teacherFilterList.innerHTML = allTeachers.map(entry => `
        <label class="teacher-filter-option" data-teacher-filter-option="${{entry.teacher}}">
          <input type="checkbox" data-teacher-filter="${{entry.teacher}}" ${{excludedTeachers.has(entry.teacher) ? "checked" : ""}} />
          <span>${{entry.teacher}}</span>
          <small>${{formatHours(entry.totalHours)}}h</small>
        </label>
      `).join("");

      teacherFilterList.querySelectorAll("input[data-teacher-filter]").forEach(input => {{
        input.addEventListener("change", () => {{
          const teacher = input.getAttribute("data-teacher-filter");
          if (!teacher) return;
          if (input.checked) {{
            excludedTeachers.add(teacher);
          }} else {{
            excludedTeachers.delete(teacher);
          }}
          updateTeacherFilterSummary();
          renderAll();
        }});
      }});

      applyTeacherFilterSearch();
      updateTeacherFilterSummary();
    }}

    teacherFilterSearch.addEventListener("input", applyTeacherFilterSearch);

    clearTeacherFilter.addEventListener("click", () => {{
      if (excludedTeachers.size === 0) return;
      excludedTeachers.clear();
      teacherFilterSearch.value = "";
      renderTeacherFilter();
      renderAll();
    }});

    document.addEventListener("click", event => {{
      if (teacherFilterMenu.open && !teacherFilterMenu.contains(event.target)) {{
        teacherFilterMenu.removeAttribute("open");
      }}
    }});

    function buildTeacherStudentHourText(metric, variant) {{
      const scoreIds = variant.score_ids || [];
      const teacherMap = new Map();

      detailRows.forEach(d => {{
        if ((toNumber(d.matched) ?? 0) !== 1) return;
        if (excludedTeachers.has(d.teacher)) return;
        if (metric.id !== "coverage_rate" && scoreIds.length > 0) {{
          const hasMetricScore = scoreIds.some(scoreId => toNumber(d[`score_${{scoreId}}`]) !== null);
          if (!hasMetricScore) return;
        }}

        const teacher = d.teacher;
        const studentName = (d.student_raw_name || d.student || "").trim();
        const hours = toNumber(d.student_teacher_hours);
        if (!teacher || !studentName || hours === null) return;

        if (!teacherMap.has(teacher)) {{
          teacherMap.set(teacher, new Map());
        }}
        const studentMap = teacherMap.get(teacher);
        const old = studentMap.get(studentName);
        if (old === undefined || hours > old) {{
          studentMap.set(studentName, hours);
        }}
      }});

      const out = {{}};
      teacherMap.forEach((studentMap, teacher) => {{
        const labels = Array.from(studentMap.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name, hours]) => `${{name}}, ${{formatHours(hours)}}h`);
        out[teacher] = labels.join("；");
      }});
      return out;
    }}

    function getDisplaySortValue(metric, value) {{
      const displayPrecision = metric.isPercent ? 1 : 3;
      return Number(value.toFixed(displayPrecision));
    }}

    function compareMetricRows(metric, a, b) {{
      const scoreDiff = getDisplaySortValue(metric, b.value) - getDisplaySortValue(metric, a.value);
      if (scoreDiff !== 0) return scoreDiff;
      const hourDiff = b.totalHours - a.totalHours;
      if (hourDiff !== 0) return hourDiff;
      return String(a.teacher || "").localeCompare(String(b.teacher || ""), "zh-Hans-CN");
    }}

    function buildMetricRows(metric, variant) {{
      const teacherStudentHourText = buildTeacherStudentHourText(metric, variant);
      return getVisibleRows().map(r => {{
        const valueCount = toNumber(r[variant.count_key]);
        if (valueCount === null || valueCount <= 0) return null;
        let value = toNumber(r[variant.value_key]);
        if (value === null) return null;
        if (metric.isPercent) value = value * 100;

        const responseCount = toNumber(r.response_record_count) ?? 0;
        if (responseCount <= 0) return null;

        return {{
          teacher: r.teacher,
          value,
          valueCount,
          coverage: (toNumber(r.coverage_rate) ?? 0) * 100,
          totalHours: toNumber(r.teacher_total_hours) ?? 0,
          matchedResponseCount: toNumber(r.matched_response_record_count) ?? 0,
          responseCount,
          studentHourSummary: teacherStudentHourText[r.teacher] || "",
        }};
      }}).filter(Boolean).sort((a, b) => compareMetricRows(metric, a, b));
    }}

    function renderMetricChart(metric, variant, sortedRows) {{
      const c = getChart();
      if (!c) {{
        return;
      }}
      const topRows = sortedRows.slice(0, 25);
      const highlightFlags = computeChartHighlightFlags(metric, topRows);
      const backgroundColors = topRows.map((_, idx) =>
        highlightFlags[idx]
          ? "rgba(13, 148, 136, 0.88)"
          : "rgba(29, 78, 216, 0.82)"
      );
      const borderColors = topRows.map((_, idx) =>
        highlightFlags[idx]
          ? "rgba(15, 118, 110, 1)"
          : "rgba(30, 64, 175, 1)"
      );
      c.data.labels = topRows.map(r => r.teacher);
      c.data.datasets[0].label = `${{metric.label}} - ${{variant.label}}`;
      c.data.datasets[0].data = topRows.map(r => r.value);
      c.data.datasets[0].valueLabels = topRows.map(r => formatChartValue(metric, r.value));
      c.data.datasets[0].feedbackCounts = topRows.map(r => r.responseCount);
      c.data.datasets[0].totalHours = topRows.map(r => r.totalHours);
      c.data.datasets[0].backgroundColor = backgroundColors;
      c.data.datasets[0].borderColor = borderColors;
      c.options.scales.y.max = metric.scaleMax;
      c.update();
    }}

    function renderMetricTable(metric, variant, sortedRows) {{
      const headers = ["排名", "老师", "评价学员+课时", "分值", "样本条数", "覆盖率", "总课时", "匹配反馈条数", "反馈总条数"];
      const body = sortedRows.slice(0, 50).map((r, idx) => [
        idx + 1,
        r.teacher,
        r.studentHourSummary,
        formatValue(metric, r.value),
        r.valueCount,
        `${{r.coverage.toFixed(1)}}%`,
        r.totalHours.toFixed(2),
        r.matchedResponseCount,
        r.responseCount,
      ]);

      metricTable.innerHTML = `
        <thead><tr>${{headers.map(h => `<th>${{h}}</th>`).join("")}}</tr></thead>
        <tbody>${{body.map(row => `<tr>${{row.map(c => `<td>${{c}}</td>`).join("")}}</tr>`).join("")}}</tbody>
      `;
    }}

    function renderMeta(metric, variant, sortedRows) {{
      const totalHours = sortedRows.reduce((sum, r) => sum + r.totalHours, 0);
      const weightedAvg = totalHours > 0
        ? sortedRows.reduce((sum, r) => sum + (r.value * r.totalHours), 0) / totalHours
        : 0;
      metricMeta.innerHTML = `
        <span class="badge">当前维度：${{variant.label}}</span>
        <span class="badge">老师数：${{sortedRows.length}}</span>
        <span class="badge">均值(总课时加权)：${{formatValue(metric, weightedAvg)}}</span>
        <span class="badge">颜色：上半区高亮</span>
        <span class="badge">排序：展示分值高 -> 低，展示分值相同按总课时高 -> 低</span>
      `;
    }}

    function renderTextTable() {{
      const headers = ["老师"];
      textCatalog.forEach(item => {{
        headers.push(`${{item.label}}(条数)`);
        headers.push(`${{item.label}}样例`);
      }});

      const bodyRows = getVisibleRows()
        .map(r => {{
          const countSum = textCatalog.reduce((sum, item) => sum + (toNumber(r[`text_${{item.id}}_count_all`]) ?? 0), 0);
          return {{ countSum, row: r }};
        }})
        .sort((a, b) => b.countSum - a.countSum)
        .map((entry) => {{
          const row = entry.row;
          const cells = [row.teacher];
          textCatalog.forEach(item => {{
            cells.push(toNumber(row[`text_${{item.id}}_count_all`]) ?? 0);
            cells.push(row[`text_${{item.id}}_samples_all`] || "");
          }});
          return cells;
        }});

      textTable.innerHTML = `
        <thead><tr>${{headers.map(h => `<th>${{h}}</th>`).join("")}}</tr></thead>
        <tbody>${{bodyRows.map(row => `<tr>${{row.map(c => `<td>${{c}}</td>`).join("")}}</tr>`).join("")}}</tbody>
      `;
    }}

    function renderAll() {{
      renderMetricTabs();
      const metric = metrics.find(m => m.id === currentMetricId) || metrics[0];
      if (!metric.variants.find(v => v.id === currentVariantId)) {{
        currentVariantId = metric.variants[0].id;
      }}
      const variant = metric.variants.find(v => v.id === currentVariantId) || metric.variants[0];

      metricName.textContent = metric.label;
      metricDesc.textContent = metric.description;
      renderVariantTabs(metric);

      const sortedRows = buildMetricRows(metric, variant);
      renderMetricChart(metric, variant, sortedRows);
      renderMetricTable(metric, variant, sortedRows);
      renderMeta(metric, variant, sortedRows);
      renderTextTable();
    }}

    renderDict();
    renderTeacherFilter();
    renderAll();
  </script>
</body>
</html>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")


def generate_monthly_feedback_report(
    *,
    month: str,
    feedback_csv: Path,
    schedule_csv: Path,
    output_dir: Path,
    name_map_csv: Optional[Path] = None,
    identities: str = "学生,家长/监护人",
    combine_mode: str = "merge_by_student",
    exclude_teachers_raw: str = "",
    feedback_month_offset: int = 1,
    feedback_start_date: str = "",
    feedback_end_date: str = "",
    include_cancelled: bool = False,
    max_duration_hours: float = 8.0,
    exclude_course_type_keywords: Optional[List[str]] = None,
    score_map_csv: Optional[Path] = None,
) -> Dict[str, object]:
    month = parse_month_or_exit(month)
    score_map = load_score_text_map(score_map_csv)
    feedback_csv = Path(feedback_csv).expanduser().resolve()
    schedule_csv = Path(schedule_csv).expanduser().resolve()
    name_map_csv = (
        Path(name_map_csv).expanduser().resolve()
        if name_map_csv is not None
        else DEFAULT_NAME_MAP
    )
    output_dir = Path(output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not feedback_csv.exists():
        raise SystemExit(f"反馈文件不存在: {feedback_csv}")
    if not schedule_csv.exists():
        raise SystemExit(f"课表文件不存在: {schedule_csv}")

    name_map = load_name_map(name_map_csv)
    identity_filter = parse_identity_filter(identities)
    excluded_teachers = parse_name_set(exclude_teachers_raw)
    course_type_keywords = exclude_course_type_keywords or [
        "请假",
        "假期",
        "空出",
        "文书",
        "会议",
        "课表确定",
    ]

    teacher_total_hours, teacher_student_hours, student_total_hours, schedule_stats = read_schedule(
        schedule_csv=schedule_csv,
        month=month,
        include_cancelled=include_cancelled,
        max_duration_hours=max_duration_hours,
        exclude_course_type_keywords=course_type_keywords,
        teacher_map=name_map["teacher"],
        student_map=name_map["student"],
    )

    raw_feedback_records, feedback_stats = read_feedback_latest(
        feedback_csv=feedback_csv,
        month=month,
        identity_filter=identity_filter,
        teacher_map=name_map["teacher"],
        student_map=name_map["student"],
        feedback_month_offset=feedback_month_offset,
        feedback_start_date=feedback_start_date,
        feedback_end_date=feedback_end_date,
    )

    org_analysis = analyze_org_fields(raw_feedback_records)
    for field_id, info in org_analysis.items():
        if info["distribution"]:
            dist = "，".join(f"{k}:{v}" for k, v in info["distribution"].items())
            print(f"[机构分析] {info['label']}（{info['respondent_count']}份）: {dist}")

    unmapped_score_texts = collect_unmapped_score_texts(raw_feedback_records, score_map)
    if unmapped_score_texts:
        print("[警告] 以下评分列出现无法对应分值的文本答案（已按缺失处理，请补充映射表）：")
        for column, counter in unmapped_score_texts.items():
            for answer, count in counter.items():
                print(f"        - [{column}] 「{answer}」x{count}")

    feedback_records = merge_feedback_records(
        base_records=raw_feedback_records,
        combine_mode=combine_mode,
        score_map=score_map,
    )

    filtered_inputs = filter_excluded_teachers(
        records=feedback_records,
        teacher_total_hours=teacher_total_hours,
        teacher_student_hours=teacher_student_hours,
        raw_feedback_records=raw_feedback_records,
        excluded_teachers=excluded_teachers,
    )
    feedback_records = filtered_inputs["records"]
    teacher_total_hours = filtered_inputs["teacher_total_hours"]
    teacher_student_hours = filtered_inputs["teacher_student_hours"]
    raw_feedback_records = filtered_inputs["raw_feedback_records"]
    if excluded_teachers:
        schedule_stats["teacher_count_in_month"] = len(teacher_total_hours)
        schedule_stats["student_count_in_month"] = len(
            {student for (_, student), hours in teacher_student_hours.items() if hours > 0}
        )
        schedule_stats["total_teacher_hours"] = round(sum(teacher_total_hours.values()), 6)

    apply_weights(
        records=feedback_records,
        teacher_total_hours=teacher_total_hours,
        teacher_student_hours=teacher_student_hours,
        student_total_hours=student_total_hours,
    )

    summary_rows = build_teacher_summary(
        records=feedback_records,
        teacher_total_hours=teacher_total_hours,
        teacher_student_hours=teacher_student_hours,
        raw_feedback_records=raw_feedback_records,
    )

    detail_rows: List[Dict[str, object]] = []
    unmatched_rows: List[Dict[str, object]] = []
    for rec in feedback_records:
        row = {
            "teacher": rec.teacher,
            "student": rec.student,
            "student_raw_name": rec.student_raw_name,
            "identity": rec.identity,
            "source_identities": rec.source_identities,
            "submitted_at": rec.submitted_at,
            "teacher_total_hours": round(rec.teacher_total_hours, 6),
            "student_teacher_hours": round(rec.student_teacher_hours, 6),
            "student_total_hours": round(rec.student_total_hours, 6),
            "raw_weight": round(rec.raw_weight, 8),
            "normalized_weight": round(rec.normalized_weight, 8),
            "matched": int(rec.matched),
        }

        for field in NUMERIC_SCORE_FIELDS:
            score_id = field["id"]
            row[f"score_{score_id}"] = (
                round(rec.scores[score_id], 6) if rec.scores.get(score_id) is not None else ""
            )

        for text_field in TEXT_FEEDBACK_FIELDS:
            text_id = text_field["id"]
            row[f"text_{text_id}"] = rec.text_feedback.get(text_id, "")

        detail_rows.append(row)
        if not rec.matched:
            unmatched_rows.append(row)

    detail_fieldnames = [
        "teacher",
        "student",
        "student_raw_name",
        "identity",
        "source_identities",
        "submitted_at",
        "teacher_total_hours",
        "student_teacher_hours",
        "student_total_hours",
        "raw_weight",
        "normalized_weight",
        "matched",
    ]
    detail_fieldnames.extend([f"score_{f['id']}" for f in NUMERIC_SCORE_FIELDS])
    detail_fieldnames.extend([f"text_{f['id']}" for f in TEXT_FEEDBACK_FIELDS])

    summary_fieldnames = [
        "teacher",
        "teacher_total_hours",
        "response_record_count",
        "matched_response_record_count",
        "merged_response_record_count",
        "matched_merged_response_record_count",
        "responded_student_count",
        "responded_hours_distinct_students",
        "coverage_rate",
        "raw_weight_sum",
        "normalized_weight_sum",
    ]

    for metric in METRIC_VIEWS:
        for variant in metric["variants"]:
            metric_prefix = f"metric_{metric['id']}_{variant['id']}"
            summary_fieldnames.extend(
                [
                    f"{metric_prefix}_label",
                    f"{metric_prefix}_description",
                    f"{metric_prefix}_scale_max",
                    f"{metric_prefix}_value_count",
                    f"{metric_prefix}_raw_avg",
                    f"{metric_prefix}_normalized_avg",
                ]
            )

    for text_field in TEXT_FEEDBACK_FIELDS:
        text_id = text_field["id"]
        summary_fieldnames.extend(
            [
                f"text_{text_id}_label",
                f"text_{text_id}_description",
                f"text_{text_id}_count_all",
                f"text_{text_id}_count_matched",
                f"text_{text_id}_samples_all",
                f"text_{text_id}_samples_matched",
            ]
        )

    teacher_text_rows = build_teacher_text_feedback_rows(summary_rows)
    teacher_text_fieldnames = ["teacher"]
    for text_field in TEXT_FEEDBACK_FIELDS:
        text_id = text_field["id"]
        teacher_text_fieldnames.extend(
            [
                f"{text_id}_count_all",
                f"{text_id}_count_matched",
                f"{text_id}_samples_all",
                f"{text_id}_samples_matched",
            ]
        )

    teacher_score_rows, teacher_score_fieldnames = build_teacher_score_table(summary_rows)

    write_csv(output_dir / "respondent_detail.csv", detail_rows, detail_fieldnames)
    write_csv(output_dir / "unmatched_feedback.csv", unmatched_rows, detail_fieldnames)
    write_csv(output_dir / "teacher_summary.csv", summary_rows, summary_fieldnames)
    write_csv(
        output_dir / "teacher_text_feedback.csv",
        teacher_text_rows,
        teacher_text_fieldnames,
    )
    write_csv(
        output_dir / "teacher_scores.csv",
        teacher_score_rows,
        teacher_score_fieldnames,
    )
    write_dashboard_html(
        output_dir / "dashboard.html",
        month,
        summary_rows,
        feedback_records,
    )

    run_meta = {
        "run_at": datetime.now().isoformat(timespec="seconds"),
        "month": month,
        "input_feedback_csv": str(feedback_csv),
        "input_schedule_csv": str(schedule_csv),
        "input_name_map_csv": str(name_map_csv),
        "identity_filter": sorted(identity_filter) if identity_filter else "all",
        "combine_mode": combine_mode,
        "exclude_teachers": sorted(excluded_teachers),
        "feedback_month_offset": feedback_month_offset,
        "feedback_start_date": feedback_start_date,
        "feedback_end_date": feedback_end_date,
        "include_cancelled": bool(include_cancelled),
        "max_duration_hours": max_duration_hours,
        "exclude_course_type_keywords": course_type_keywords,
        "schedule_stats": {
            **{k: v for k, v in schedule_stats.items() if k != "cancel_value_counter"},
            "cancel_value_counter": dict(schedule_stats["cancel_value_counter"]),
        },
        "feedback_stats": {
            **{k: v for k, v in feedback_stats.items() if k != "feedback_identity_counter"},
            "feedback_identity_counter": dict(feedback_stats["feedback_identity_counter"]),
        },
        "score_map_csv": str(score_map_csv) if score_map_csv else "",
        "unmapped_score_texts": unmapped_score_texts,
        "org_analysis": org_analysis,
        "output_dir": str(output_dir),
        "output_files": [
            "respondent_detail.csv",
            "unmatched_feedback.csv",
            "teacher_summary.csv",
            "teacher_text_feedback.csv",
            "teacher_scores.csv",
            "dashboard.html",
            "run_meta.json",
        ],
    }
    (output_dir / "run_meta.json").write_text(
        json.dumps(run_meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    matched_count = sum(1 for r in feedback_records if r.matched)
    return {
        "month": month,
        "output_dir": output_dir,
        "summary_rows": summary_rows,
        "detail_rows": detail_rows,
        "unmatched_rows": unmatched_rows,
        "teacher_text_rows": teacher_text_rows,
        "teacher_score_rows": teacher_score_rows,
        "feedback_records": feedback_records,
        "run_meta": run_meta,
        "matched_count": matched_count,
        "teacher_count": len(teacher_total_hours),
        "total_teacher_hours": sum(teacher_total_hours.values()),
    }


def main() -> None:
    args = parse_args()
    month = parse_month_or_exit(args.month)
    output_root = Path(args.output_dir).expanduser().resolve()
    output_dir = output_root / month

    result = generate_monthly_feedback_report(
        month=month,
        feedback_csv=Path(args.feedback),
        schedule_csv=Path(args.schedule),
        output_dir=output_dir,
        name_map_csv=Path(args.name_map),
        identities=args.identities,
        combine_mode=args.combine_mode,
        exclude_teachers_raw=args.exclude_teachers,
        feedback_month_offset=args.feedback_month_offset,
        feedback_start_date=args.feedback_start_date,
        feedback_end_date=args.feedback_end_date,
        include_cancelled=args.include_cancelled,
        max_duration_hours=args.max_duration_hours,
        exclude_course_type_keywords=[
            x.strip() for x in args.exclude_course_type_keywords.split(",") if x.strip()
        ],
        score_map_csv=Path(args.score_map) if args.score_map else None,
    )

    print(f"[完成] 月份: {month}")
    print(f"[完成] 输出目录: {output_dir}")
    print(
        "[统计] 反馈记录(去重后): "
        f"{len(result['feedback_records'])}，成功匹配课时: {result['matched_count']}，匹配率: "
        f"{(result['matched_count'] / len(result['feedback_records']) * 100 if result['feedback_records'] else 0):.2f}%"
    )
    print(
        f"[统计] 老师数: {result['teacher_count']}，总课时: "
        f"{result['total_teacher_hours']:.2f}"
    )


if __name__ == "__main__":
    main()
