# Workspace Cleanup Implementation Plan（历史）

> 本文档记录 2026-04-12 的执行过程。当前数据和输出路径以 app README 与仓库 `data/README.md` 为准。

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 整理当前菁仕月度反馈项目目录，删除可再生垃圾文件，并补充未来 AI 可直接使用的参考文档。

**Architecture:** 保持现有输入文件名和脚本默认路径不变，避免打断现有出数流程；仅删除 `.DS_Store` 和 `__pycache__` 这类可再生文件，并新增一份工作台说明文档来固化目录规则与执行要点。

**Tech Stack:** 本地文件系统、Markdown、Python unittest

### Task 1: 盘点当前目录并固化保留规则

**Files:**
- Create: `docs/AI工作台说明.md`
- Reference: `README_月度反馈处理模板.md`
- Reference: `scripts/monthly_teacher_feedback.py`
- Reference: `outputs/teacher-feedback/2026-02/run_meta.json`
- Reference: `outputs/teacher-feedback/2026-03/run_meta.json`

1. 识别根目录中的原始输入、脚本、模板、测试与产出物。
2. 明确保留项、可删除项与谨慎删除项。
3. 记录未来 AI 继续执行时必须遵守的路径约定。

### Task 2: 暴露参考入口

**Files:**
- Modify: `README_月度反馈处理模板.md`
- Create: `docs/AI工作台说明.md`

1. 在 README 顶部加入“先看哪些文件”的索引。
2. 让未来 AI 能快速定位到脚本、模板、输入和输出目录规则。

### Task 3: 清理可再生垃圾文件

**Files:**
- Delete content from: `./.DS_Store`
- Delete content from: `./docs/.DS_Store`
- Delete content from: `./outputs/teacher-feedback/.DS_Store`
- Delete content from: `./scripts/.DS_Store`
- Delete directory contents from: `./scripts/__pycache__/`
- Delete directory contents from: `./tests/__pycache__/`

1. 删除 Finder 元数据文件。
2. 删除 Python 字节码缓存目录。
3. 不触碰任何 CSV、脚本、测试和历史产出目录。

### Task 4: 验证整理结果

**Files:**
- Verify: `docs/AI工作台说明.md`
- Verify: `README_月度反馈处理模板.md`

1. 运行 `find . -name '.DS_Store' -o -name '__pycache__'`，预期无输出。
2. 运行 `python3 -m unittest tests/test_monthly_teacher_feedback.py`，预期通过。
3. 复查目录结构，确认 `outputs/teacher-feedback/2026-02` 与 `outputs/teacher-feedback/2026-03` 仍保留。
