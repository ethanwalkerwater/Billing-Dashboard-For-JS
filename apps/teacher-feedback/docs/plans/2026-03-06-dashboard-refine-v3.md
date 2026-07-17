# Dashboard Refine V3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修正均值与老师筛选口径，优化 dashboard 布局和明细表字段，提高可读性。

**Architecture:** 在 `scripts/monthly_teacher_feedback.py` 的前端渲染 JS 中修正数值解析和过滤逻辑，并把明细数据作为 payload 下发前端，支持“评价学员+课时”列渲染；同时调整布局为单栏并增加反馈概览展示高度。

**Tech Stack:** Python 标准库 + HTML/CSS/JS + Chart.js

### Task 1: 修正均值与筛选口径
**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. 修正 `toNumber` 对空字符串的处理（空值不再转 0）。
2. 图表与表格仅保留“当前指标有有效样本”的老师。
3. 均值改为“老师总课时加权均值”，并在标签中明确。

### Task 2: 调整布局
**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. 去掉右侧独立“指标说明”占位，改为主区域内说明块。
2. 扩大主图横向空间。

### Task 3: 明细表新增“评价学员+课时”列
**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. 给 dashboard 注入 `respondent_detail` 的轻量 payload。
2. 根据当前指标维度聚合老师下学员及课时，展示为 `姓名, 课时h`。

### Task 4: 反馈概览显示更多行
**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`

1. 增大/取消反馈表区域高度限制。
2. 默认展示更多条目。

### Task 5: 验证
**Files:**
- Modify: none

1. 重新生成 2026-01 和 2026-02。
2. `node --check` 验证生成 JS 语法。
