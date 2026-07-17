# Vercel Feedback Service Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Vercel-hosted feedback processing service so users can upload a feedback CSV and a schedule CSV, choose a month and feedback window, and generate teacher evaluation outputs without using the terminal.

**Architecture:** Keep the existing Python scoring logic as the single source of truth. Extract a reusable report-generation function from the CLI script, then add a Vercel Python API that accepts uploaded CSVs, writes them to a temporary directory, runs the shared report function, and returns generated files plus summary JSON. Serve a static frontend from the repo root that uploads files to the API and provides download links for the generated outputs.

**Tech Stack:** Python 3, existing standard-library CSV processing, FastAPI for Vercel Python runtime, static HTML/CSS/JS frontend, Vercel deployment config.

### Task 1: Add a reusable report-generation entry point

**Files:**
- Modify: `scripts/monthly_teacher_feedback.py`
- Test: `tests/test_monthly_teacher_feedback.py`

**Step 1: Write the failing test**

Add a test that creates tiny schedule/feedback CSV fixtures, calls a shared Python function instead of the CLI, and asserts that:
- output files are generated into a requested directory
- `run_meta` contains the requested month and feedback window
- `teacher_summary.csv` exists and is non-empty

**Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_monthly_teacher_feedback.MonthlyTeacherFeedbackTests.test_generate_monthly_feedback_report_writes_outputs`

Expected: FAIL because the shared entry point does not exist yet.

**Step 3: Write minimal implementation**

Extract the current `main()` workflow into a reusable function, e.g.:
- `generate_monthly_feedback_report(...) -> Dict[str, object]`

Keep CLI behavior by having `main()` parse args and call the new function.

**Step 4: Run test to verify it passes**

Run the single unittest again and confirm PASS.

### Task 2: Add Vercel web frontend and upload API

**Files:**
- Create: `api/process.py`
- Create: `index.html`
- Create: `requirements.txt`
- Create: `vercel.json`
- Modify: `scripts/monthly_teacher_feedback.py`

**Step 1: Write the failing test**

Prefer a lightweight test on the shared bundle-building layer rather than the FastAPI route directly. Add a helper-oriented test if needed for serializing generated files for web download.

**Step 2: Run test to verify it fails**

Run the targeted unittest and confirm the missing helper/path fails.

**Step 3: Write minimal implementation**

Implement:
- static upload UI with fields:
  - month
  - feedback start date
  - feedback end date
  - excluded teachers
  - feedback CSV upload
  - schedule CSV upload
- FastAPI endpoint that:
  - accepts multipart form upload
  - writes uploads to a temp directory
  - calls shared report function
  - reads generated files back into memory
  - returns JSON for summary + downloadable file contents
- `vercel.json` to exclude local large CSVs, `outputs/`, `docs/`, and `tests/` from function bundle where appropriate

**Step 4: Run focused validation**

Run:
- `python3 -m py_compile api/process.py scripts/monthly_teacher_feedback.py`

Expected: no syntax errors.

### Task 3: Document deployment and usage

**Files:**
- Modify: `README_月度反馈处理模板.md`

**Step 1: Update docs**

Add:
- local development command
- Vercel deployment expectation
- how users upload files and download outputs
- note about Vercel request size constraints and keeping files current

**Step 2: Verify docs reference the actual new command/fields**

Cross-check the frontend labels and API fields match the implementation.

### Task 4: Full verification

**Files:**
- Verify generated app and tests

**Step 1: Run unit tests**

Run: `python3 -m unittest tests.test_monthly_teacher_feedback`

Expected: all tests pass.

**Step 2: Run an end-to-end local smoke command**

Run a small script or direct function call that generates a report into a temp directory using the current local CSVs.

Expected:
- outputs created successfully
- `run_meta.json` records the inputs

**Step 3: Verify deployable file set**

Check that these files exist:
- `index.html`
- `api/process.py`
- `requirements.txt`
- `vercel.json`

Plan complete and saved to `docs/plans/2026-05-12-vercel-feedback-service.md`.
