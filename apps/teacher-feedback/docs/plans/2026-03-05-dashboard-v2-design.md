# Dashboard V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 升级月度反馈看板，支持按指标独立排序展示、指标说明、文本反馈展示与明细增强。

**Architecture:** 在现有 `monthly_teacher_feedback.py` 内扩展数据模型和聚合层，新增指标变体（总/学生/家长）与文本反馈统计；输出增强后的 CSV，并生成 shadcn 风格的单页交互 dashboard（指标切换+维度切换）。

**Tech Stack:** Python 标准库（csv/json/dataclass）+ 纯 HTML/CSS/JS + Chart.js

### Task 1: 扩展数据模型与指标配置

**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. 增加数值字段配置（学生/家长分列）和文本字段配置（改进/推荐理由等）。
2. 扩展 `FeedbackRecord`：保存原始学员名、学员当月总课时、文本字段。
3. 抽象“指标展示配置”用于 dashboard。

### Task 2: 扩展清洗与聚合逻辑

**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. `read_schedule` 新增按学员汇总总课时。
2. `read_feedback_latest` 保留原始学员名并提取文本字段。
3. `merge_feedback_records` 支持合并文本与分列数值。
4. `build_teacher_summary` 产出指标变体（总/学生/家长）与文本统计。

### Task 3: 输出增强

**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. `respondent_detail.csv` 增加：反馈学员原始名、该老师课时、学员月总课时。
2. 新增 `teacher_text_feedback.csv`：老师文本反馈汇总与示例。
3. `teacher_summary.csv` 增加各指标变体的加权结果。

### Task 4: 重新设计 dashboard

**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. 使用 shadcn 风格变量与卡片布局。
2. 指标 Tab：每个指标单独展示、按值降序。
3. 维度切换：支持“总/学生/家长”切换（有对应数据的指标）。
4. 增加“指标说明”与“文本反馈统计表”。

### Task 5: 验证与回归

**Files:**
- Modify: `README_月度反馈处理模板.md`

1. 运行 2026-02 与 2026-01。
2. 通过 py_compile 验证脚本。
3. 更新 README 说明新输出与新交互。
