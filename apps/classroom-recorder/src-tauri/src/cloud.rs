//! classroom-api：飞书登录轮询、拉课表、下课后整节课直传 + finish（升级前录了一半的课仍按分段传）、总结保存。

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
        let res = f(self.http.request(method, format!("{}{path}", self.api)).bearer_auth(&token).header("x-device", device).header("x-classroom-signed-session", "1")).send().await;
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
            _ => {
                if let Some(renewed) = res.headers().get("x-classroom-session").and_then(|value| value.to_str().ok()) {
                    let mut g = self.lock();
                    if g.cfg.token.as_deref() == Some(token.as_str()) {
                        g.cfg.token = Some(renewed.into());
                        self.save_cfg(&g.cfg);
                    }
                }
                Ok(res)
            }
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
        let Ok(res) = core.http.get(format!("{}/auth/poll", core.api)).query(&[("state", &state)]).header("x-classroom-signed-session", "1").send().await else { continue };
        match res.status().as_u16() {
            200 => {
                let Ok(v) = res.json::<Value>().await else { break };
                let Some(token) = v["token"].as_str() else { break };
                {
                    let mut g = core.lock();
                    if g.login_gen != gen {
                        return;
                    }
                    g.login_gen += 1;
                    g.lessons.clear();
                    g.cfg.token = Some(token.into());
                    g.cfg.teacher = Some(v["teacher"].clone());
                    g.logging_in = false;
                    core.save_cfg(&g.cfg);
                }
                core.request_status();
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

/// 老师主动打开窗口、刷新时一起取录音与报告状态。
pub async fn fetch_once(core: &Arc<Core>) -> Result<(), String> {
    fetch_lessons(core, true).await
}

async fn fetch_lessons(core: &Arc<Core>, with_status: bool) -> Result<(), String> {
    let _request = core.fetch_lock.lock().await;
    let generation = core.lock().login_gen;
    let path = if with_status { "/lessons" } else { "/schedule" };
    let mut v: Value = core.call(Method::GET, path, |rb| rb).await?.json().await.map_err(|_| "课表数据异常，请稍后再试")?;
    let lessons = serde_json::from_value::<Vec<Lesson>>(v["lessons"].take()).map_err(|_| "课表数据异常，请稍后再试")?;
    core.set_lessons(generation, lessons, with_status);
    Ok(())
}

/// 后台启动、每天早上和错过刷新后的唤醒只拉课表；状态由老师打开主窗口时请求。
pub async fn fetch_loop(core: Arc<Core>) {
    use std::sync::atomic::Ordering::Relaxed;
    loop {
        let with_status = core.foreground_fetch.swap(false, Relaxed);
        let now = now_ms();
        let last = core.last_fetch.load(Relaxed);
        let due = last == 0 || now >= crate::engine::next_morning(last);
        if (with_status || due) && core.lock().cfg.token.is_some() {
            match fetch_lessons(&core, with_status).await {
                Ok(()) => discard_pending(&core).await,
                Err(e) => eprintln!("[lessons] {e}"),
            }
            let c = core.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || c.refresh_mics()).await;
        }
        let wait = crate::engine::fetch_wait(now_ms(), core.last_fetch.load(Relaxed));
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

/// 扫描本机所有课的目录：上课时每满 5 分钟传一块 → 下课后补传最后一块并 finish → 已完成 7 天的删除。
/// 块直传云存储、签名不查库（第一块除外），云端整节到齐才拼起来转写；网好时下课后再整段直传一次，省掉云端拼接。
/// 每节课各自退避 1s→2s→…→5min；状态全在 lesson.json，重启后接着传。
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
                let res = upload_lesson(&core, &dir, &id).await;
                if let Ok(lf) = recorder::read(&dir) {
                    core.set_progress(&id, recorder::cloud_bytes(&lf));
                }
                match res {
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
                        core.sent(&id, false);
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

/// 云端说这节课已经不要录音了（已经在用别的录音出报告）：本机记完成
fn mark_done(core: &Arc<Core>, dir: &Path, id: &str) -> Result<(), ApiError> {
    recorder::update(dir, |lf| {
        lf.finished = true;
        lf.finished_at = Some(now_ms());
    })
    .map_err(local)?;
    core.sent(id, true);
    Ok(())
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
    // 升级到 0.1.12 前已经按分段传过一部分的课：照旧按分段传完，云端合并
    let legacy = lf.segments.iter().any(|s| s.uploaded);
    for seg in lf.segments.iter().filter(|s| legacy && !s.uploaded) {
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
    // 上课时满 5 分钟就传一块，下课后补传最后一块（整段直传成功过的不用再传块）
    if !legacy && lf.audio.is_none() {
        for n in recorder::pending_parts(&lf) {
            if !put_part(core, dir, id, n).await? {
                return mark_done(core, dir, id);
            }
            core.set_progress(id, recorder::cloud_bytes(&recorder::read(dir).map_err(local)?));
            core.publish();
        }
    }
    let mut lf = recorder::read(dir).map_err(local)?;
    let Some(ended_at) = lf.ended_at else { return Ok(()) };
    if legacy && lf.segments.iter().any(|s| !s.uploaded) {
        return Ok(());
    }
    // 一段都没录到的照旧报空清单，云端记「未录制」
    let direct = !legacy && !lf.segments.is_empty();
    // 网好（上课时每块都一次传上）：整段再直传一次，云端不用拼（拼要花云函数流量）；2 分钟传不完就交给云端用块拼
    if direct && lf.audio.is_none() && !lf.part_trouble {
        let bytes = recorder::concat(dir, &lf).map_err(local)?;
        let audio = recorder::Audio { sha256: recorder::sha256_hex(&bytes), bytes: bytes.len() as u64 };
        match put_audio(core, dir, id, bytes).await {
            Ok(true) => recorder::update(dir, |lf| lf.audio = Some(audio)).map_err(local)?,
            Ok(false) => return mark_done(core, dir, id),
            Err(ApiError::Net | ApiError::Local(_)) => recorder::update(dir, |lf| lf.part_trouble = true).map_err(local)?,
            Err(e) => return Err(e),
        }
        lf = recorder::read(dir).map_err(local)?;
    }
    // 随时录制：等老师填主题（录音照传），10 分钟没填按默认
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
    let mut body = json!({ "startedAt": iso(lf.started_at), "endedAt": iso(ended_at) });
    match (&lf.audio, direct) {
        (Some(a), true) => body["audio"] = json!({ "sha256": a.sha256, "bytes": a.bytes }),
        (None, true) => {
            // 按块拼：清单按本机分段算，整节的校验值给云端拼完核对
            let bytes = recorder::concat(dir, &lf).map_err(local)?;
            body["audio"] = json!({ "sha256": recorder::sha256_hex(&bytes), "bytes": bytes.len() });
            body["parts"] = json!(recorder::ready_parts(&lf).iter().map(|&n| json!({ "n": n, "bytes": recorder::part_bytes(&lf, n) })).collect::<Vec<_>>());
        }
        _ => body["segments"] = json!(lf.segments.iter().map(|s| json!({ "seq": s.seq, "sha256": s.sha256, "bytes": s.bytes })).collect::<Vec<_>>()),
    }
    if let Some(m) = &lf.mic {
        body["mic"] = json!(m);
    }
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
    if direct && v["reupload"].as_bool() == Some(true) {
        // 整段没传全：改成让云端用块拼
        recorder::update(dir, |lf| (lf.audio, lf.part_trouble) = (None, true)).map_err(local)?;
        return Err(ApiError::Local("云端没有收到完整录音，改用分块".into()));
    }
    let missing: Vec<u32> = v["missing"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect()).unwrap_or_default();
    let n = lf.segments.len();
    let parts_mode = direct && lf.audio.is_none();
    let done = recorder::update(dir, |lf| {
        if !missing.is_empty() && parts_mode {
            lf.parts.retain(|p| !missing.contains(&p.n)); // 云端说这几块没到：重传
        } else if !missing.is_empty() {
            lf.segments.iter_mut().filter(|s| missing.contains(&s.seq)).for_each(|s| s.uploaded = false);
        } else if lf.ended_at == Some(ended_at) && lf.segments.len() == n {
            lf.finished = true;
            lf.finished_at = Some(now_ms());
        }
        lf.finished
    })
    .map_err(local)?;
    if !missing.is_empty() {
        core.shared.kick_upload.notify_one();
    }
    if done {
        core.sent(id, true);
    }
    core.publish();
    Ok(())
}

/// 传第 n 块：要一个签名地址（服务端固定 60 秒内开始传，实测慢速传 100 秒也收），直连存储，连不上再走系统代理。
/// 第一块带 first=1，云端借这次建档；之后的块签名不查库。Ok(false) = 云端已经不要这节课的录音了。
async fn put_part(core: &Arc<Core>, dir: &Path, id: &str, n: u32) -> Result<bool, ApiError> {
    let lf = recorder::read(dir).map_err(local)?;
    let bytes = recorder::part_audio(dir, &lf, n).map_err(local)?;
    let len = bytes.len() as u64;
    let mut path = format!("/lessons/{id}/part-url?n={n}");
    if !lf.parts_registered {
        path += "&first=1";
    }
    if lf.upload_fails > 0 {
        path += &format!("&fails={}&last={}", lf.upload_fails, lf.upload_error);
    }
    let v: Value = core.call(Method::POST, &path, |rb| rb).await?.json().await.map_err(|_| ApiError::Net)?;
    if v["done"].as_bool() == Some(true) {
        return Ok(false);
    }
    let url = v["url"].as_str().ok_or(ApiError::Net)?.to_string();
    recorder::update(dir, |lf| lf.parts_registered = true).map_err(local)?;
    // 一块约 1.2 MB：20 KB/s 的烂网也只要 1 分钟
    let error = send_audio(core, &url, bytes, Duration::from_secs(5 * 60), &format!("part{n}")).await;
    recorder::update(dir, |lf| match &error {
        None => {
            (lf.upload_fails, lf.upload_error) = (0, String::new());
            lf.parts.retain(|p| p.n != n);
            lf.parts.push(recorder::Part { n, bytes: len });
        }
        Some(e) => {
            (lf.upload_fails, lf.upload_error) = (lf.upload_fails + 1, e.clone());
            lf.part_trouble = true;
        }
    })
    .map_err(local)?;
    match error {
        None => Ok(true),
        Some(e) => {
            eprintln!("[upload] {id}: {e}");
            Err(ApiError::Net)
        }
    }
}

/// 网好时下课后整段直传一次（云端不用再花流量拼块）。只给 2 分钟：传不完说明网不够好，改由云端用已到的块拼。
/// Ok(false) = 云端已经不要这份录音了（已经在用别的录音出报告）。
async fn put_audio(core: &Arc<Core>, dir: &Path, id: &str, bytes: Vec<u8>) -> Result<bool, ApiError> {
    let lf = recorder::read(dir).map_err(local)?;
    let mut path = format!("/lessons/{id}/upload-url?kind=final");
    if lf.upload_fails > 0 {
        path += &format!("&fails={}&last={}", lf.upload_fails, lf.upload_error);
    }
    let v: Value = core.call(Method::POST, &path, |rb| rb).await?.json().await.map_err(|_| ApiError::Net)?;
    if v["done"].as_bool() == Some(true) {
        return Ok(false);
    }
    let url = v["url"].as_str().ok_or(ApiError::Net)?.to_string();
    let error = send_audio(core, &url, bytes, Duration::from_secs(120), "final").await;
    recorder::update(dir, |lf| match &error {
        Some(e) => (lf.upload_fails, lf.upload_error) = (lf.upload_fails + 1, e.clone()),
        None => (lf.upload_fails, lf.upload_error) = (0, String::new()),
    })
    .map_err(local)?;
    match error {
        None => Ok(true),
        Some(e) => {
            eprintln!("[upload] {id}: {e}");
            Err(ApiError::Net)
        }
    }
}

/// PUT 到签名地址。存储在上海，先直连（绕开老师的 VPN 代理）；直连连不上（极少数网络只能走代理）再走系统代理。
/// 返回 None = 成功；否则是查询参数里放得下的失败原因（标签-线路-原因-秒数），下次签名时报给云端。
async fn send_audio(core: &Arc<Core>, url: &str, bytes: Vec<u8>, timeout: Duration, label: &str) -> Option<String> {
    let started = now_ms();
    let put = |client: &reqwest::Client, bytes: Vec<u8>| {
        client.put(url).header(reqwest::header::CONTENT_TYPE, "audio/mpeg").header("x-upsert", "true").timeout(timeout).body(bytes).send()
    };
    let (mut res, mut route) = (put(&core.http_direct, bytes.clone()).await, "direct");
    if res.as_ref().is_err_and(|e| e.is_connect()) {
        (res, route) = (put(&core.http, bytes).await, "proxy");
    }
    let secs = (now_ms() - started) / 1000;
    match &res {
        Ok(r) if r.status().is_success() => None,
        // 存储的报错（签名过期等）一律按网络问题退避重试，不能当成云端拒收（403/404/409 在上面有别的含义）
        Ok(r) => Some(format!("{label}-{route}-http{}-{secs}s", r.status().as_u16())),
        Err(e) => {
            core.set_online(false);
            Some(format!("{label}-{route}-{}-{secs}s", upload_error_kind(e)))
        }
    }
}

/// reqwest 错误 → 查询参数里放得下的短词，带上最底层的原因（connection reset、timed out 之类）
fn upload_error_kind(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() { "timeout" } else if e.is_connect() { "connect" } else if e.is_body() { "body" } else { "net" };
    let mut cause: &dyn std::error::Error = e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    let cause: String = cause.to_string().chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).take(40).collect();
    format!("{kind}-{cause}")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::{LessonFile, Segment};

    #[test]
    fn parts_ready_every_ten_segments_and_join_back_to_whole() {
        let dir = std::env::temp_dir().join(format!("classroom-parts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut lf = LessonFile::default();
        for seq in 1..=23u32 {
            let bytes = format!("seg{seq};").into_bytes();
            std::fs::write(recorder::seg_path(&dir, seq), &bytes).unwrap();
            lf.segments.push(Segment { seq, sha256: recorder::sha256_hex(&bytes), bytes: bytes.len() as u64, uploaded: false });
        }
        // 还在录：只有满 10 段的块能传，第 3 块（21–23 段）还在长
        assert_eq!(recorder::ready_parts(&lf), [0, 1]);
        lf.ended_at = Some(1);
        assert_eq!(recorder::ready_parts(&lf), [0, 1, 2]);
        // 三块按序号拼起来必须和整节一模一样：云端拼完要和这个校验值对上
        let joined: Vec<u8> = (0..3).flat_map(|n| recorder::part_audio(&dir, &lf, n).unwrap()).collect();
        assert_eq!(joined, recorder::concat(&dir, &lf).unwrap());
        // 传过的块内容没变就不重传；续录后最后一块变长了要重传
        lf.parts = vec![recorder::Part { n: 0, bytes: recorder::part_bytes(&lf, 0) }, recorder::Part { n: 2, bytes: recorder::part_bytes(&lf, 2) }];
        assert_eq!(recorder::pending_parts(&lf), [1]);
        let (up, total) = recorder::cloud_bytes(&lf);
        assert_eq!(total - up, recorder::part_bytes(&lf, 1));
        let extra = b"seg24;".to_vec();
        std::fs::write(recorder::seg_path(&dir, 24), &extra).unwrap();
        lf.segments.push(Segment { seq: 24, sha256: recorder::sha256_hex(&extra), bytes: 6, uploaded: false });
        assert_eq!(recorder::pending_parts(&lf), [1, 2]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concat_in_seq_order_checks_source_files() {
        let dir = std::env::temp_dir().join(format!("classroom-concat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(recorder::seg_path(&dir, 2), b"bb").unwrap();
        std::fs::write(recorder::seg_path(&dir, 1), b"a").unwrap();
        let seg = |seq, bytes: &[u8]| Segment { seq, sha256: recorder::sha256_hex(bytes), bytes: bytes.len() as u64, uploaded: false };
        let lf = LessonFile { segments: vec![seg(2, b"bb"), seg(1, b"a")], ..Default::default() };
        assert_eq!(recorder::concat(&dir, &lf).unwrap(), b"abb");
        std::fs::write(recorder::seg_path(&dir, 2), b"bc").unwrap();
        assert!(recorder::concat(&dir, &lf).is_err());
        std::fs::remove_file(recorder::seg_path(&dir, 2)).unwrap();
        assert!(recorder::concat(&dir, &lf).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
