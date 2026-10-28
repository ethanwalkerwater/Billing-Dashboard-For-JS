//! classroom-api：飞书登录轮询、拉课表、分段上传 + finish 清单、总结保存。

use crate::engine::{now_ms, Core, Lesson, MIN, NAME_WAIT};
use crate::recorder;
use reqwest::{Method, RequestBuilder, Response};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const KEEP_LOCAL: i64 = 7 * 24 * 60 * MIN;

pub enum ApiError {
    Net,
    Auth,
    Status(u16, String),
    Local(String),
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> String {
        match e {
            ApiError::Net => "网络连接失败，请稍后再试".into(),
            ApiError::Auth => "登录已失效，请重新使用飞书登录".into(),
            ApiError::Status(_, m) | ApiError::Local(m) => m,
        }
    }
}

fn local(e: std::io::Error) -> ApiError {
    ApiError::Local(e.to_string())
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default()
}

impl Core {
    /// 带登录态的请求：顺手维护 online 标记，401 清掉 token。
    pub async fn call(self: &Arc<Self>, method: Method, path: &str, f: impl FnOnce(RequestBuilder) -> RequestBuilder) -> Result<Response, ApiError> {
        let (token, device) = {
            let g = self.lock();
            (g.cfg.token.clone().ok_or(ApiError::Auth)?, g.cfg.device.clone())
        };
        let res = f(self.http.request(method, format!("{}{path}", self.api)).bearer_auth(&token).header("x-device", device)).send().await;
        self.set_online(matches!(&res, Ok(r) if r.status().as_u16() < 500));
        let res = res.map_err(|_| ApiError::Net)?;
        match res.status().as_u16() {
            401 => {
                self.expire_token(&token);
                Err(ApiError::Auth)
            }
            s if s >= 400 => {
                let msg = res.json::<Value>().await.ok().and_then(|v| v["message"].as_str().map(String::from));
                Err(ApiError::Status(s, msg.unwrap_or_else(|| format!("服务暂时不可用（{s}）"))))
            }
            _ => Ok(res),
        }
    }
}

// ---------- 登录 ----------

pub async fn login(core: Arc<Core>) -> Result<(), String> {
    let start: Value = async { core.http.get(format!("{}/auth/start", core.api)).send().await?.error_for_status()?.json().await }
        .await
        .map_err(|_| "无法连接登录服务，请检查网络")?;
    let (Some(state), Some(url)) = (start["state"].as_str(), start["url"].as_str()) else {
        return Err("登录服务返回异常".into());
    };
    core.app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    let gen = {
        let mut g = core.lock();
        g.login_gen += 1;
        g.logging_in = true;
        g.login_gen
    };
    core.publish();
    let state = state.to_string();
    tauri::async_runtime::spawn(poll_login(core, state, gen));
    Ok(())
}

async fn poll_login(core: Arc<Core>, state: String, gen: u32) {
    let deadline = now_ms() + 10 * MIN;
    while now_ms() < deadline {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if core.lock().login_gen != gen {
            return; // 用户重新点了登录或退出
        }
        let Ok(res) = core.http.get(format!("{}/auth/poll", core.api)).query(&[("state", &state)]).send().await else { continue };
        match res.status().as_u16() {
            200 => {
                let Ok(v) = res.json::<Value>().await else { break };
                let Some(token) = v["token"].as_str() else { break };
                {
                    let mut g = core.lock();
                    if g.login_gen != gen {
                        return;
                    }
                    g.cfg.token = Some(token.into());
                    g.cfg.teacher = Some(v["teacher"].clone());
                    g.logging_in = false;
                    core.save_cfg(&g.cfg);
                }
                core.kick_fetch.notify_one();
                core.shared.kick_upload.notify_one();
                core.publish();
                if let Some(w) = core.app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                return;
            }
            s if s == 202 || s >= 500 => continue,
            _ => break, // 410 过期 / 403 不是老师：浏览器页面已经给了说明
        }
    }
    {
        let mut g = core.lock();
        if g.login_gen == gen {
            g.logging_in = false;
        }
    }
    core.publish();
}

// ---------- 课表 ----------

/// 拉一次课表。手动「刷新」直接调它，好把失败原因告诉老师。
pub async fn fetch_once(core: &Arc<Core>) -> Result<(), String> {
    let token = core.lock().cfg.token.clone().ok_or("请先用飞书登录")?;
    let mut v: Value = core.call(Method::GET, "/lessons", |rb| rb).await?.json().await.map_err(|_| "课表数据异常，请稍后再试")?;
    let lessons = serde_json::from_value::<Vec<Lesson>>(v["lessons"].take()).map_err(|_| "课表数据异常，请稍后再试")?;
    core.set_lessons(&token, lessons);
    core.last_fetch.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 自动拉课表：启动时一次，之后按 engine::fetch_wait 等（每天早上一次），或被 kick_fetch 叫醒（登录、打开主窗口、睡醒时错过了早上那次）。
pub async fn fetch_loop(core: Arc<Core>) {
    loop {
        if core.lock().cfg.token.is_some() {
            if let Err(e) = fetch_once(&core).await {
                eprintln!("[lessons] {e}");
            }
            discard_pending(&core).await;
            let c = core.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || c.refresh_mics()).await;
        }
        let wait = crate::engine::fetch_wait(now_ms(), core.last_fetch.load(std::sync::atomic::Ordering::Relaxed));
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(wait as u64)) => {}
            _ = core.kick_fetch.notified() => {}
        }
    }
}

/// 通知云端放弃老师在 App 里删掉的课（不再转写、不出总结）；断网没发出去的，下次拉课表时再发。
pub async fn discard_pending(core: &Arc<Core>) {
    let ids = core.lock().cfg.discard.clone();
    for id in ids {
        match core.call(Method::POST, &format!("/lessons/{id}/discard"), |rb| rb).await {
            Ok(_) | Err(ApiError::Status(400..=499, _)) => {
                let mut g = core.lock();
                g.cfg.discard.retain(|d| *d != id);
                core.save_cfg(&g.cfg);
            }
            Err(e) => eprintln!("[discard] {id}: {}", String::from(e)),
        }
    }
}

// ---------- 上传 ----------

/// 扫描本机所有课的目录：补传未上传分段 → 录完的课提交清单 → 已完成 7 天的删除。
/// 每节课各自退避 1s→2s→…→5min，互不阻塞；状态全在 lesson.json，重启后接着传。
pub async fn upload_loop(core: Arc<Core>) {
    let mut backoff: HashMap<String, (i64, i64)> = HashMap::new(); // id → (下次时间, 退避秒数)
    loop {
        let now = now_ms();
        if core.lock().cfg.token.is_some() {
            let dirs: Vec<_> = std::fs::read_dir(core.dir.join("recordings")).map(|it| it.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
            for dir in dirs {
                let id = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
                if backoff.get(&id).is_some_and(|b| now < b.0) {
                    continue;
                }
                match upload_lesson(&core, &dir, &id).await {
                    Ok(()) => {
                        backoff.remove(&id);
                    }
                    Err(ApiError::Auth) => break,
                    // 403 = 不是当前登录老师的课（换过账号）：原账号再登录还能传，只是先不打扰
                    Err(ApiError::Status(403, msg)) => {
                        eprintln!("[upload] {id}: {msg}, retry in 1h");
                        backoff.insert(id, (now_ms() + 60 * MIN, 3600));
                    }
                    Err(ApiError::Status(404 | 409, msg)) => {
                        eprintln!("[upload] {id}: permanently rejected: {msg}");
                        let _ = recorder::update(&dir, |lf| lf.failed = Some(msg));
                    }
                    Err(e) => {
                        let secs = backoff.get(&id).map_or(1, |b| (b.1 * 2).min(300));
                        eprintln!("[upload] {id}: {} (retry in {secs}s)", String::from(e));
                        backoff.insert(id, (now_ms() + secs * 1000, secs));
                    }
                }
            }
        }
        let wait = backoff.values().map(|b| b.0 - now_ms()).min().unwrap_or(15_000).clamp(200, 15_000);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(wait as u64)) => {}
            _ = core.shared.kick_upload.notified() => {}
        }
    }
}

async fn upload_lesson(core: &Arc<Core>, dir: &Path, id: &str) -> Result<(), ApiError> {
    if !crate::engine::safe_id(id) {
        return Ok(());
    }
    let lf = recorder::read(dir).map_err(local)?;
    if lf.finished || lf.failed.is_some() {
        if lf.finished_at.or(lf.ended_at).is_some_and(|t| now_ms() - t > KEEP_LOCAL) {
            std::fs::remove_dir_all(dir).map_err(local)?;
            core.lock().adhoc.remove(id);
        }
        return Ok(());
    }
    for seg in lf.segments.iter().filter(|s| !s.uploaded) {
        let bytes = match std::fs::read(recorder::seg_path(dir, seg.seq)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // 文件没了就没法补传，从清单里去掉，免得整节课卡住
                recorder::update(dir, |lf| lf.segments.retain(|s| s.seq != seg.seq)).map_err(local)?;
                continue;
            }
            Err(e) => return Err(local(e)),
        };
        core.call(Method::POST, &format!("/lessons/{id}/segments/{}", seg.seq), |rb| {
            rb.header("x-sha256", &seg.sha256).header(reqwest::header::CONTENT_TYPE, "audio/mpeg").body(bytes)
        })
        .await?;
        recorder::update(dir, |lf| lf.segments.iter_mut().filter(|s| s.seq == seg.seq).for_each(|s| s.uploaded = true)).map_err(local)?;
        core.publish();
    }
    let mut lf = recorder::read(dir).map_err(local)?;
    let Some(ended_at) = lf.ended_at else { return Ok(()) };
    if lf.segments.iter().any(|s| !s.uploaded) {
        return Ok(());
    }
    // 随时录制：等老师填主题（分段照传），10 分钟没填按默认
    if crate::engine::is_adhoc(id) && lf.meta.is_none() {
        if now_ms() < ended_at + NAME_WAIT {
            return Ok(());
        }
        core.name_if_unnamed(id);
        lf = recorder::read(dir).map_err(local)?;
        if lf.meta.is_none() {
            return Ok(()); // 正在等的那段由 tick 按默认填，下一轮再提交
        }
    }
    let mut body = json!({
        "startedAt": iso(lf.started_at),
        "endedAt": iso(ended_at),
        "segments": lf.segments.iter().map(|s| json!({ "seq": s.seq, "sha256": s.sha256, "bytes": s.bytes })).collect::<Vec<_>>(),
    });
    if let Some(m) = &lf.meta {
        body["topic"] = json!(m.topic);
        body["kind"] = json!(m.kind);
    }
    // 崩溃时正暂停着、之后没再续录的：暂停算到结束
    let pauses: Vec<(i64, i64)> = lf.pauses.iter().copied().chain(lf.paused_at.filter(|p| *p < ended_at).map(|p| (p, ended_at))).collect();
    if !pauses.is_empty() {
        body["pauses"] = json!(pauses.iter().map(|(a, b)| json!({ "start": iso(*a), "end": iso(*b) })).collect::<Vec<_>>());
    }
    let v: Value = core.call(Method::POST, &format!("/lessons/{id}/finish"), |rb| rb.json(&body)).await?.json().await.map_err(|_| ApiError::Net)?;
    let missing: Vec<u32> = v["missing"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect()).unwrap_or_default();
    let n = lf.segments.len();
    recorder::update(dir, |lf| {
        if !missing.is_empty() {
            lf.segments.iter_mut().filter(|s| missing.contains(&s.seq)).for_each(|s| s.uploaded = false);
        } else if lf.ended_at == Some(ended_at) && lf.segments.len() == n {
            lf.finished = true;
            lf.finished_at = Some(now_ms());
        }
    })
    .map_err(local)?;
    if !missing.is_empty() {
        core.shared.kick_upload.notify_one();
    }
    core.publish();
    Ok(())
}

// ---------- 合并反馈 ----------

/// 选好的几节课交给云端合并成一份反馈（约 15 秒，云端在这次请求里做完），然后重新拉一次课表，列表里就有了。
/// 同一个编号再提交 = 「重新选课程」。生成失败时那一项已经建好，列表里显示「整理中」，云端会自动重试。
pub async fn merge(core: &Arc<Core>, id: &str, lessons: &[String]) -> Result<(), String> {
    if !crate::engine::is_merged(id) || !crate::engine::safe_id(id) || !lessons.iter().all(|l| crate::engine::safe_id(l)) {
        return Err("课程编号无效".into());
    }
    let res = core.call(Method::POST, &format!("/merges/{id}"), |rb| rb.json(&json!({ "lessonIds": lessons })).timeout(Duration::from_secs(150))).await;
    let _ = fetch_once(core).await;
    res.map(|_| ()).map_err(String::from)
}

// ---------- 总结 ----------

pub async fn save_summary(core: &Arc<Core>, id: &str, text: &str) -> Result<(), String> {
    if !crate::engine::safe_id(id) {
        return Err("课程编号无效".into());
    }
    core.call(Method::PUT, &format!("/lessons/{id}/summary"), |rb| rb.json(&json!({ "text": text }))).await?;
    {
        let mut g = core.lock();
        g.lessons.iter_mut().filter(|l| l.id == id).for_each(|l| l.summary = Some(text.into()));
    }
    core.publish();
    Ok(())
}

pub async fn mark_copied(core: &Arc<Core>, id: &str) -> Result<(), String> {
    core.call(Method::POST, &format!("/lessons/{id}/copied"), |rb| rb).await?;
    Ok(())
}
