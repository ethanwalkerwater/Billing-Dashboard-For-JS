from __future__ import annotations

import csv
import gzip
import io
import re
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from scripts.monthly_teacher_feedback import (
    generate_monthly_feedback_report,
    write_dashboard_html,
)


app = FastAPI(title="菁仕反馈服务")

# 项目根目录（api/ 的上一级），用于本地直接 `uvicorn api.process:app` 时把
# 上传页与看板页一并托管，确保前端 fetch("/api/process") 能解析到同源地址。
# 线上 Vercel 由平台托管根目录静态文件，下面的静态路由不会被命中，互不影响。
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_ROOT = PROJECT_ROOT / "public"

OUTPUT_FILES = [
    ("teacher_summary.csv", "text/csv;charset=utf-8"),
    ("teacher_scores.csv", "text/csv;charset=utf-8"),
    ("teacher_text_feedback.csv", "text/csv;charset=utf-8"),
    ("respondent_detail.csv", "text/csv;charset=utf-8"),
    ("unmatched_feedback.csv", "text/csv;charset=utf-8"),
    ("dashboard.html", "text/html;charset=utf-8"),
    ("run_meta.json", "application/json;charset=utf-8"),
]


def is_supported_csv_upload(filename: str) -> bool:
    lower = filename.lower()
    return lower.endswith(".csv") or lower.endswith(".csv.gz")


def decode_upload_content(filename: str, content: bytes) -> bytes:
    if filename.lower().endswith(".gz") or content.startswith(b"\x1f\x8b"):
        return gzip.decompress(content)
    return content


async def save_upload(upload: UploadFile, target: Path) -> None:
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=400, detail=f"{upload.filename or target.name} 为空文件")
    try:
        target.write_bytes(decode_upload_content(upload.filename or "", content))
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"{upload.filename or target.name} 解压失败") from exc


@app.get("/api/process")
@app.get("/api/process/")
async def healthcheck() -> JSONResponse:
    return JSONResponse({"ok": True})


@app.get("/")
async def serve_index() -> FileResponse:
    index_path = PUBLIC_ROOT / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="index.html 不存在")
    return FileResponse(index_path, media_type="text/html")


@app.get("/dashboard.html")
async def serve_dashboard() -> FileResponse:
    dashboard_path = PUBLIC_ROOT / "dashboard.html"
    if not dashboard_path.exists():
        raise HTTPException(status_code=404, detail="dashboard.html 不存在")
    return FileResponse(dashboard_path, media_type="text/html")


@app.post("/")
@app.post("/api/process")
@app.post("/api/process/")
async def process_feedback(
    month: str = Form(...),
    feedback_start_date: str = Form(""),
    feedback_end_date: str = Form(""),
    exclude_teachers: str = Form(""),
    identities: str = Form("学生,家长/监护人"),
    combine_mode: str = Form("merge_by_student"),
    feedback_file: UploadFile = File(...),
    schedule_file: UploadFile = File(...),
) -> JSONResponse:
    if not feedback_file.filename or not is_supported_csv_upload(feedback_file.filename):
        raise HTTPException(status_code=400, detail="反馈表必须是 CSV 文件")
    if not schedule_file.filename or not is_supported_csv_upload(schedule_file.filename):
        raise HTTPException(status_code=400, detail="课表必须是 CSV 文件")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        feedback_path = tmp_path / "feedback.csv"
        schedule_path = tmp_path / "schedule.csv"
        output_dir = tmp_path / "outputs" / month

        await save_upload(feedback_file, feedback_path)
        await save_upload(schedule_file, schedule_path)

        try:
            result = generate_monthly_feedback_report(
                month=month,
                feedback_csv=feedback_path,
                schedule_csv=schedule_path,
                output_dir=output_dir,
                feedback_start_date=feedback_start_date,
                feedback_end_date=feedback_end_date,
                exclude_teachers_raw=exclude_teachers,
                identities=identities,
                combine_mode=combine_mode,
            )
        except SystemExit as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # pragma: no cover - defensive fallback for runtime issues
            raise HTTPException(status_code=500, detail=f"处理失败: {exc}") from exc

        files = []
        for filename, content_type in OUTPUT_FILES:
            path = output_dir / filename
            if not path.exists():
                continue
            files.append(
                {
                    "name": filename,
                    "contentType": content_type,
                    "content": path.read_text(encoding="utf-8"),
                }
            )

        return JSONResponse(
            {
                "summary": {
                    "month": result["month"],
                    "teacherCount": result["teacher_count"],
                    "matchedCount": result["matched_count"],
                    "feedbackRecordCount": len(result["feedback_records"]),
                    "unmatchedCount": len(result["unmatched_rows"]),
                    "totalTeacherHours": round(result["total_teacher_hours"], 6),
                },
                "runMeta": result["run_meta"],
                "summaryRows": result["summary_rows"],
                "files": files,
            }
        )


@app.post("/api/render-dashboard")
@app.post("/api/render-dashboard/")
@app.post("/api/render_dashboard")
@app.post("/api/render_dashboard/")
async def render_dashboard(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="看板数据不是有效 JSON") from exc

    month = str(payload.get("month") or "").strip()
    summary_rows = payload.get("summaryRows")
    respondent_detail_csv = payload.get("respondentDetailCsv")

    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(status_code=400, detail="月份格式不正确")
    if not isinstance(summary_rows, list) or not all(
        isinstance(row, dict) for row in summary_rows
    ):
        raise HTTPException(status_code=400, detail="缺少月份或老师汇总数据")
    if len(summary_rows) > 500:
        raise HTTPException(status_code=413, detail="老师汇总数据过大")

    csv_content = respondent_detail_csv if isinstance(respondent_detail_csv, str) else ""
    if len(csv_content.encode("utf-8")) > 3_000_000:
        raise HTTPException(status_code=413, detail="反馈明细过大，无法刷新看板模板")
    detail_rows = list(csv.DictReader(io.StringIO(csv_content.lstrip("\ufeff"))))
    if len(detail_rows) > 10_000:
        raise HTTPException(status_code=413, detail="反馈明细条数过多")

    with tempfile.TemporaryDirectory() as tmp:
        dashboard_path = Path(tmp) / "dashboard.html"
        write_dashboard_html(
            dashboard_path,
            month,
            summary_rows,
            [],
            detail_rows_override=detail_rows,
        )
        return JSONResponse(
            {"dashboardHtml": dashboard_path.read_text(encoding="utf-8")}
        )
