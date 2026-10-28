//! 唯一状态源：课表 + 本机录制状态 → 录制决策 → app-state 快照 / 托盘 / 胶囊与通知窗口。
//!
//! 锁规则（防死锁）：持有 `inner` 时绝不调用会等主线程的 API（托盘、窗口 getter）；
//! 这些都在 `apply()` 里、释放 `inner` 之后做，而且 `publish()` 只在非主线程调用。

use crate::recorder::{self, Msg, Shared};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub const MIN: i64 = 60_000;
const PRE: i64 = 10 * MIN; // 开课前 10 分钟出胶囊
const AUTO_START: i64 = 3 * MIN; // 开课前 3 分钟自动开录
const MANUAL_EARLY: i64 = 30 * MIN; // 最早提前 30 分钟手动开录
const LATE_START: i64 = 10 * MIN; // 下课后 10 分钟内还能自动开录（崩溃 / 晚开 App）
const CAP: i64 = 30 * MIN; // 拖堂最多录到下课后 30 分钟
const QUIET: i64 = 3 * MIN; // 下课后连续 3 分钟没人说话 → 胶囊问「是否结束」
const ASK: i64 = MIN; // 问了 1 分钟没人理就停；到上限前也提前 1 分钟倒计时
const SILENT_WARN: i64 = 2 * MIN;
const ADHOC_MAX: i64 = 180 * MIN; // 随时录制最长 3 小时，忘了关也会停
pub const NAME_WAIT: i64 = 10 * MIN; // 随时录制结束后 10 分钟没填主题，按默认处理，不让整理卡住
const PAUSE_NUDGE: i64 = 10 * MIN; // 暂停满 10 分钟提醒一次（胶囊 + 通知）
const TALK_NUDGE: i64 = MIN; // 暂停中连续 1 分钟听到有人说话，提醒「好像开始讲课了？」
const TALK_BREAK: i64 = 10_000; // 超过 10 秒没人说话，「连续说话」重新算

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lesson {
    pub id: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub end: String,
    pub start_at: i64,
    pub end_at: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub topic: String,
    pub status: String,
    #[serde(default)]
    pub copied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_url: Option<String>,
    /// 随时录制："adhoc"（课程）/ "meeting"（会议）；课表里的课没有
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 随时录制已结束、还在等老师填主题（只出现在本机快照里）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_name: bool,
    /// 课表里的课有学生；App 按它找同一个学生的课来合并反馈
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub student: String,
    /// 合并反馈（kind = "merged"）由哪几节课合并
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
}

/// 随时录制：编号由 App 生成，不在课表里，不参与自动开录
pub fn is_adhoc(id: &str) -> bool {
    id.starts_with("adhoc-")
}

/// 合并反馈：编号由 App 生成，没有录音，只在云端引用几节已出报告的课
pub fn is_merged(id: &str) -> bool {
    id.starts_with("merged-")
}

/// 最晚停止时间：课表课 = 下课后 30 分钟；随时录制 = 开录后 3 小时
fn stop_at_of(l: &Lesson) -> i64 {
    if is_adhoc(&l.id) {
        l.start_at + ADHOC_MAX
    } else {
        l.end_at + CAP
    }
}

/// 按声音停的时间：下课后（或最后一次说话后，取晚的）安静 3 分钟、再问 1 分钟。随时录制不按声音停。
fn quiet_stop(l: &Lesson, voice_at: i64) -> i64 {
    if is_adhoc(&l.id) {
        i64::MAX
    } else {
        voice_at.max(l.end_at) + QUIET + ASK
    }
}

// ---------- 纯决策（可测） ----------

#[derive(Debug, PartialEq)]
pub enum Action {
    Idle,
    Start(String),
    Switch(String),
    Stop,
}

pub struct ActiveRef<'a> {
    pub id: &'a str,
    pub start_at: i64,
    pub stop_at: i64,
}

fn eligible(l: &Lesson, ended: &HashSet<String>) -> bool {
    !matches!(l.status.as_str(), "cancelled" | "done" | "processing") && !ended.contains(&l.id) && !is_adhoc(&l.id)
}

/// 每秒调用一次：该开录、换课、停录还是什么都不做。
/// 开录窗口 = [开课-3 分钟, 下课+10 分钟)，覆盖正常自动开录和崩溃/晚开 App 后的续录。
/// active.stop_at 是实际要停的时间（上限和按声音停取早的）。
pub fn decide(now: i64, lessons: &[Lesson], active: Option<&ActiveRef>, ended: &HashSet<String>) -> Action {
    if active.is_some_and(|a| now >= a.stop_at) {
        return Action::Stop;
    }
    let next = lessons
        .iter()
        .filter(|l| eligible(l, ended) && now >= l.start_at - AUTO_START && now < l.end_at + LATE_START)
        // 连堂：只会切到比正在录的更晚开始的课
        .filter(|l| active.is_none_or(|a| a.id != l.id && l.start_at > a.start_at))
        .max_by_key(|l| l.start_at);
    match (next, active) {
        (Some(l), None) => Action::Start(l.id.clone()),
        (Some(l), Some(_)) => Action::Switch(l.id.clone()),
        _ => Action::Idle,
    }
}

/// 处于「课前 10 分钟～自动开录」之间的下一节课。
pub fn pre_lesson<'a>(now: i64, lessons: &'a [Lesson], ended: &HashSet<String>) -> Option<&'a Lesson> {
    lessons
        .iter()
        .filter(|l| eligible(l, ended) && now >= l.start_at - PRE && now < l.start_at - AUTO_START)
        .min_by_key(|l| l.start_at)
}

const HOUR: i64 = 60 * MIN;

/// t 之后的第一个北京时间早上 7 点（每天自动拉一次课表的时间点）
pub fn next_morning(t: i64) -> i64 {
    const DAY: i64 = 24 * HOUR;
    let local = t + 8 * HOUR;
    let seven = local - local.rem_euclid(DAY) + 7 * HOUR - 8 * HOUR;
    if seven > t { seven } else { seven + DAY }
}

/// 下次自动拉课表要等多久（ms）。课表一般提前几周就排好，拉一次要花云函数约 2 秒，所以不轮询：
/// 启动、登录、打开主窗口、手动「刷新」时拉，另外每天早上 7 点（北京时间）拉一次兜底（老师不开窗口也能按最新课表自动录）。
/// 报告好了云端会飞书私信老师，App 不盯着等；last_ok = 上次拉成功的时间。
pub fn fetch_wait(now: i64, last_ok: i64) -> i64 {
    let due = next_morning(last_ok);
    if now >= due { 5 * MIN } else { due - now } // 上次没拉成功：5 分钟后再试
}

// ---------- 状态 ----------

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub token: Option<String>,
    pub teacher: Option<Value>,
    pub mic: String,
    pub autostart_init: bool,
    /// 本机标识：同一节课只认第一台上传的电脑，防止两台电脑的录音混在一起
    pub device: String,
    /// 设置里关掉了屏幕边上的「随时录制」悬浮按钮
    pub hide_fab: bool,
    /// 老师在 App 里删掉的课：编号 → 删除时间（只在本机隐藏，不改课表；30 天后清掉）
    pub hidden: HashMap<String, i64>,
    /// 删掉时云端已有录音、还没通知云端放弃的课（断网时下次拉课表再补发）
    pub discard: Vec<String>,
}

pub struct Active {
    pub lesson: Lesson,
    pub started_at: i64,
    pub stop_at: i64,
    pub confirm: bool,
    pub mic_since: i64,
    /// 这次暂停的开始时间；None = 在录
    pub paused_at: Option<i64>,
    /// 已经结束的暂停加起来多久（ms）：「已录」不算暂停
    pub paused_ms: i64,
    pub nudge: Nudge,
}

/// 一次暂停里的提醒：最多两次（满 10 分钟、听到讲课各一次），点了「还在聊」就不再提醒
#[derive(Default)]
pub struct Nudge {
    long: bool,
    voice: bool,
    quiet: bool,
    talk_since: Option<i64>,
    /// 胶囊上正在显示的提醒："" / "long" / "voice"
    showing: &'static str,
}

impl Nudge {
    /// 暂停中每秒一次（from = 暂停开始，voice = 最近一次听到说话）：连续 1 分钟听到有人说话、或暂停满 10 分钟，各提醒一次。
    /// 不会自动继续录。返回 true = 刚到 10 分钟，要弹通知
    fn step(&mut self, now: i64, from: i64, voice: i64) -> bool {
        if now - voice > TALK_BREAK {
            self.talk_since = None;
        } else if self.talk_since.is_none() {
            self.talk_since = Some(voice.max(from));
        }
        if self.quiet || self.showing == "voice" {
            return false;
        }
        if !self.voice && self.talk_since.is_some_and(|t| now - t >= TALK_NUDGE) {
            (self.voice, self.showing) = (true, "voice");
        } else if !self.long && now - from >= PAUSE_NUDGE {
            (self.long, self.showing) = (true, "long");
            return true;
        }
        false
    }
}

#[derive(Default)]
pub struct Inner {
    pub cfg: Config,
    pub logging_in: bool,
    pub login_gen: u32,
    pub lessons: Vec<Lesson>,
    pub active: Option<Active>,
    pub ended: HashSet<String>,
    /// 本机的随时录制（课表里没有）；云端列表还没有它或还没整理完时，用这份显示
    pub adhoc: HashMap<String, Lesson>,
    /// 刚结束、等老师填主题的随时录制：(编号, 结束时间)
    pub naming: Option<(String, i64)>,
    orphans: Vec<(String, i64)>, // 崩溃遗留、还没结束的本机录音：(课程, 最晚停止时间)
    last_id: Option<String>,
    last_sec: i64,
    processing_until: Option<i64>,
    pub mics: Vec<String>,
    pub default_mic: String,
    pub autostart: bool,
    pub toast: Option<Value>,
    pub selected: Option<String>,
    pub online: bool,
    pub preview_ui: bool,
    preview_on: bool,
    /// 已下载好、等老师点「重启更新」的新版本号
    pub update_ready: Option<String>,
    retry_at: i64,
    last_tick: i64,
    last_json: String,
}

impl Inner {
    /// 课表 + 本机状态：正在录的 → recording；本机已录完、云端还没开始处理 → processing。
    pub fn merged(&self) -> Vec<Lesson> {
        let mut v = self.lessons.clone();
        if let Some(a) = &self.active {
            if !v.iter().any(|l| l.id == a.lesson.id) {
                v.push(a.lesson.clone());
            }
        }
        for (id, local) in &self.adhoc {
            match v.iter_mut().find(|l| l.id == *id) {
                // 云端整理完之前，标题和类型以本机老师刚填的为准（finish 之前云端还是「随时录制」）
                Some(l) if l.status != "done" => (l.title, l.kind) = (local.title.clone(), local.kind.clone()),
                Some(_) => {}
                None => v.push(local.clone()),
            }
        }
        for l in &mut v {
            l.needs_name = self.naming.as_ref().is_some_and(|(id, _)| *id == l.id);
            if self.active.as_ref().is_some_and(|a| a.lesson.id == l.id) {
                l.status = "recording".into();
            } else if self.ended.contains(&l.id) && matches!(l.status.as_str(), "upcoming" | "recording") {
                l.status = "processing".into();
            }
        }
        v
    }
}

struct RecView {
    mode: &'static str,
    lesson_id: Option<String>,
    sec: i64,
    paused: bool,
    paused_sec: i64,
    nudge: &'static str,
    end_left: i64,
    auto_stop_at: String,
    auto_start_at: String,
}

struct View {
    state: Option<Value>,
    status: String,
    title: String,
    recording: bool,
    paused: bool,
    pill: bool,
    naming: bool,
    fab: bool,
    toast: bool,
}

#[derive(Default)]
struct TrayUi {
    status_item: Option<MenuItem<Wry>>,
    recording: bool,
    paused: bool,
    status: String,
    title: String,
    pill: bool,
    naming: bool,
    fab: bool,
    toast: bool,
}

pub struct Core {
    pub app: AppHandle,
    pub dir: PathBuf,
    pub api: String,
    pub http: reqwest::Client,
    pub inner: Mutex<Inner>,
    pub rec: Sender<Msg>,
    pub shared: Arc<Shared>,
    pub kick_fetch: tokio::sync::Notify,
    /// 上次拉成功课表的时间（ms）：主窗口获得焦点时据此节流，睡醒时据此判断是否错过了早上那次
    pub last_fetch: std::sync::atomic::AtomicI64,
    ui: Mutex<TrayUi>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn hms(s: i64) -> String {
    format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// 课表按上海时间排，海外老师的电脑时区不同也按上海时间显示
fn shanghai() -> chrono::FixedOffset {
    chrono::FixedOffset::east_opt(8 * 3600).unwrap()
}

fn hhmm(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&shanghai()).format("%H:%M").to_string())
        .unwrap_or_default()
}

/// 课程 id 来自服务端，会拼进本机路径和 URL，只放行飞书 record_id 这类字符。
pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Core {
    pub fn new(app: AppHandle) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(dir.join("recordings"))?;
        let cfg: Config = std::fs::read(dir.join("config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut g = Inner { online: true, ..Default::default() };
        // 本机录音：有 endedAt 的算已结束；没有的是崩溃遗留，交给 tick 续录或收尾
        for e in std::fs::read_dir(dir.join("recordings"))?.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            let Ok(lf) = recorder::read(&e.path()) else { continue };
            if is_adhoc(&id) && lf.started_at > 0 {
                let mut l = lf.lesson.clone();
                if let Some(m) = &lf.meta {
                    (l.title, l.kind) = (m.topic.clone(), Some(m.kind.clone()));
                }
                g.adhoc.insert(id.clone(), l);
                if let (Some(end), None, false) = (lf.ended_at, &lf.meta, lf.finished) {
                    if g.naming.as_ref().is_none_or(|(_, t)| *t < end) {
                        g.naming = Some((id.clone(), end));
                    }
                }
            }
            if lf.ended_at.is_some() {
                g.ended.insert(id);
            } else if lf.started_at > 0 {
                g.orphans.push((id, lf.stop_at.max(stop_at_of(&lf.lesson))));
            }
        }
        (g.mics, g.default_mic) = recorder::list_mics();
        let shared = Arc::new(Shared::default());
        let rec = recorder::spawn(app.clone(), shared.clone(), cfg.mic.clone());
        g.cfg = cfg;
        if g.cfg.device.is_empty() {
            g.cfg.device = recorder::sha256_hex(format!("{:?}{}{}", std::time::SystemTime::now(), std::process::id(), dir.display()).as_bytes())[..16].into();
        }
        let api = std::env::var("CLASSROOM_API").unwrap_or_else(|_| "https://app.jsjy.asia/classroom-api".into());
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(90)).build()?;
        let core = Arc::new(Core { app, dir, api, http, inner: Mutex::new(g), rec, shared, kick_fetch: Default::default(), last_fetch: Default::default(), ui: Default::default() });
        core.save_cfg(&core.lock().cfg);
        Ok(core)
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn lesson_dir(&self, id: &str) -> Option<PathBuf> {
        safe_id(id).then(|| self.dir.join("recordings").join(id))
    }

    pub fn save_cfg(&self, cfg: &Config) {
        if let Err(e) = serde_json::to_vec_pretty(cfg).map_err(std::io::Error::other).and_then(|b| recorder::write_atomic(&self.dir.join("config.json"), &b)) {
            eprintln!("[config] save: {e}");
        }
    }

    // ---------- 录制会话 ----------

    pub fn start_session(&self, g: &mut Inner, lesson: Lesson, now: i64) -> Result<(), String> {
        let dir = self.lesson_dir(&lesson.id).ok_or("课程编号无效")?;
        let (seq, started_at) = recorder::begin(&dir, &lesson, now, stop_at_of(&lesson)).map_err(|e| format!("无法保存录音：{e}"))?;
        let stop_at = recorder::read(&dir).map(|lf| lf.stop_at).unwrap_or(stop_at_of(&lesson));
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = self.rec.send(Msg::Start { dir: dir.clone(), seq, reply: tx });
        let res = rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| Err("麦克风没有响应".into()));
        if let Err(e) = res {
            // 一段都没录到就把目录清掉；已有分段则按已结束处理，交给上传收尾
            let empty = recorder::read(&dir).is_ok_and(|lf| lf.segments.is_empty());
            if empty {
                let _ = std::fs::remove_dir_all(&dir);
            } else {
                let _ = recorder::update(&dir, |lf| lf.ended_at = Some(now));
                g.ended.insert(lesson.id.clone());
            }
            return Err(e);
        }
        self.shared.heard.store(false, Ordering::Relaxed);
        self.shared.voice_at.store(now, Ordering::Relaxed);
        self.shared.paused.store(false, Ordering::Relaxed);
        g.orphans.retain(|(id, _)| *id != lesson.id);
        g.ended.remove(&lesson.id);
        g.processing_until = None;
        // 崩溃后续录：之前的暂停照样不算进「已录」；崩溃时正暂停着的，接着暂停
        let (paused_ms, paused_at) = recorder::read(&dir).map(|lf| (lf.pauses.iter().map(|(a, b)| b - a).sum(), lf.paused_at)).unwrap_or((0, None));
        self.shared.paused.store(paused_at.is_some(), Ordering::Relaxed);
        g.active = Some(Active { lesson, started_at, stop_at, confirm: false, mic_since: now, paused_at, paused_ms, nudge: Nudge::default() });
        Ok(())
    }

    /// 停录并落盘：等录音线程写完最后一段，再记 endedAt，然后交给上传。
    pub fn stop_session(&self, g: &mut Inner, now: i64) {
        self.unpause(g, now); // 暂停着结束：暂停一直算到结束
        let Some(a) = g.active.take() else { return };
        let (tx, rx) = std::sync::mpsc::channel();
        if self.rec.send(Msg::Stop { reply: tx }).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(10));
        }
        if let Some(dir) = self.lesson_dir(&a.lesson.id) {
            if let Err(e) = recorder::update(&dir, |lf| lf.ended_at = Some(now)) {
                eprintln!("[engine] end {}: {e}", a.lesson.id);
            }
        }
        g.ended.insert(a.lesson.id.clone());
        g.last_sec = (now - a.started_at - a.paused_ms) / 1000;
        g.processing_until = Some(now + 2600);
        if is_adhoc(&a.lesson.id) {
            // 随时录制：胶囊不显示「正在整理」，先请老师填主题；上一段还没填的按默认处理
            self.default_name(g, now, true);
            if let Some(l) = g.adhoc.get_mut(&a.lesson.id) {
                (l.end, l.end_at) = (hhmm(now), now);
            }
            g.naming = Some((a.lesson.id.clone(), now));
            g.processing_until = None;
        }
        g.last_id = Some(a.lesson.id);
        self.shared.kick_upload.notify_one();
    }

    // ---------- 随时录制 ----------

    pub fn start_adhoc(self: &Arc<Self>) -> Result<(), String> {
        let now = now_ms();
        {
            let mut g = self.lock();
            if g.cfg.token.is_none() {
                return Err("请先用飞书登录".into());
            }
            if g.active.is_some() {
                return Err("正在录制，请先结束".into());
            }
            self.default_name(&mut g, now, true);
            let id = format!("adhoc-{}", &recorder::sha256_hex(format!("{now}{}{}", g.cfg.device, std::process::id()).as_bytes())[..16]);
            let t = chrono::DateTime::from_timestamp_millis(now).unwrap_or_default().with_timezone(&shanghai());
            let lesson = Lesson {
                id: id.clone(),
                date: t.format("%Y-%m-%d").to_string(),
                start: t.format("%H:%M").to_string(),
                start_at: now,
                end_at: now + ADHOC_MAX,
                title: "随时录制".into(),
                status: "upcoming".into(),
                kind: Some("adhoc".into()),
                ..Default::default()
            };
            g.adhoc.insert(id, lesson.clone());
            if let Err(e) = self.start_session(&mut g, lesson.clone(), now) {
                g.adhoc.remove(&lesson.id);
                return Err(e);
            }
        }
        self.publish();
        Ok(())
    }

    /// 写入老师填的主题和类型，交给上传提交 finish
    pub fn set_name(&self, g: &mut Inner, id: &str, topic: &str, kind: &str, now: i64) -> Result<(), String> {
        let dir = self.lesson_dir(id).filter(|d| is_adhoc(id) && d.join("lesson.json").exists()).ok_or("找不到这段录音")?;
        let start = g.adhoc.get(id).map(|l| l.start.clone()).unwrap_or_default();
        let topic: String = topic.trim().chars().take(30).collect();
        let meta = recorder::AdhocMeta {
            topic: if topic.is_empty() { format!("随时录制 {start}") } else { topic },
            kind: if kind == "meeting" { "meeting" } else { "adhoc" }.into(),
        };
        recorder::update(&dir, |lf| lf.meta = Some(meta.clone())).map_err(|e| format!("无法保存：{e}"))?;
        if let Some(l) = g.adhoc.get_mut(id) {
            (l.title, l.kind) = (meta.topic, Some(meta.kind));
        }
        if g.naming.as_ref().is_some_and(|(n, _)| n == id) {
            g.naming = None;
            if g.active.is_none() {
                g.processing_until = Some(now + 2600);
                g.last_id = Some(id.into());
            }
        }
        self.shared.kick_upload.notify_one();
        Ok(())
    }

    /// 等主题的那段：超过 10 分钟（或 force：又要开始新的录制）就按「课程 + 随时录制 HH:MM」处理
    fn default_name(&self, g: &mut Inner, now: i64, force: bool) {
        let Some((id, ended)) = g.naming.clone() else { return };
        if force || now >= ended + NAME_WAIT {
            if let Err(e) = self.set_name(g, &id, "", "adhoc", now) {
                eprintln!("[engine] default name {id}: {e}");
                g.naming = None;
            }
        }
    }

    /// 上传兜底：崩溃遗留、没人等主题的随时录制，结束 10 分钟后按默认提交
    pub fn name_if_unnamed(&self, id: &str) {
        let mut g = self.lock();
        if g.naming.as_ref().is_none_or(|(n, _)| n != id) {
            let _ = self.set_name(&mut g, id, "", "adhoc", now_ms());
        }
    }

    pub fn tick(self: &Arc<Self>) {
        let now = now_ms();
        {
            let mut g = self.lock();
            // 电脑刚睡醒、睡着时错过了每天早上那次拉课表（睡眠期间计时器不走）
            let slept = g.last_tick != 0 && now - g.last_tick > 15_000;
            if slept && now >= next_morning(self.last_fetch.load(Ordering::Relaxed)) {
                self.kick_fetch.notify_one();
            }
            // 合盖睡眠期间麦克风没在录：睡醒发现该停了，结束时间记成睡着那一刻，而不是打开电脑的时间
            let end = if slept { g.last_tick } else { now };
            g.last_tick = now;
            self.default_name(&mut g, now, false);
            let active_id = g.active.as_ref().map(|a| a.lesson.id.clone());
            let (done, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut g.orphans).into_iter().partition(|(id, t)| now >= *t && Some(id) != active_id.as_ref());
            g.orphans = keep;
            for (id, _) in done {
                let Some(dir) = self.lesson_dir(&id) else { continue };
                let end = std::fs::metadata(dir.join("lesson.json")).and_then(|m| m.modified()).map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis()).unwrap_or(now);
                if recorder::end(&dir, end).is_ok() {
                    g.ended.insert(id);
                    self.shared.kick_upload.notify_one();
                }
            }
            // 崩溃 / 重启后续录：按 lesson.json 里的课程和截止时间（含「再录 15 分钟」），不依赖课表是否已拉到
            if g.active.is_none() && now >= g.retry_at {
                let resume = g.orphans.iter().find(|(_, t)| now < *t).and_then(|(id, _)| self.lesson_dir(id)).and_then(|d| recorder::read(&d).ok());
                if let Some(lf) = resume {
                    let id = lf.lesson.id.clone();
                    if let Err(e) = self.start_session(&mut g, lf.lesson, now) {
                        eprintln!("[engine] resume {id}: {e}");
                        g.retry_at = now + 30_000;
                    }
                }
            }
            self.check_pause(&mut g, now);
            let action = {
                let a = g.active.as_ref().map(|a| ActiveRef { id: &a.lesson.id, start_at: a.lesson.start_at, stop_at: self.stop_of(a) });
                decide(now, &g.lessons, a.as_ref(), &g.ended)
            };
            match action {
                Action::Stop => self.stop_session(&mut g, end),
                Action::Start(id) | Action::Switch(id) if now >= g.retry_at => {
                    self.stop_session(&mut g, end);
                    if let Some(l) = g.lessons.iter().find(|l| l.id == id).cloned() {
                        if let Err(e) = self.start_session(&mut g, l, now) {
                            eprintln!("[engine] auto start {id}: {e}");
                            g.retry_at = now + 30_000;
                        }
                    }
                }
                _ => {}
            }
        }
        self.publish();
    }

    pub fn set_fab(self: &Arc<Self>, enabled: bool) {
        {
            let mut g = self.lock();
            g.cfg.hide_fab = !enabled;
            self.save_cfg(&g.cfg);
        }
        self.publish();
    }

    pub fn shutdown(&self) {
        let mut g = self.lock();
        self.stop_session(&mut g, now_ms());
    }

    /// 实际要停的时间：上限和按声音停取早的
    fn stop_of(&self, a: &Active) -> i64 {
        a.stop_at.min(quiet_stop(&a.lesson, self.shared.voice_at.load(Ordering::Relaxed)))
    }

    // ---------- 快照与界面 ----------

    fn rec_view(&self, g: &Inner, now: i64) -> RecView {
        let mut r = RecView { mode: "idle", lesson_id: None, sec: 0, paused: false, paused_sec: 0, nudge: "", end_left: 0, auto_stop_at: String::new(), auto_start_at: String::new() };
        if let Some(a) = &g.active {
            let silent = !self.shared.heard.load(Ordering::Relaxed) && now - a.mic_since >= SILENT_WARN;
            let stop = self.stop_of(a);
            r.mode = if a.confirm {
                "confirm"
            } else if now >= stop - ASK {
                if stop < a.stop_at { "quiet" } else { "ending" }
            } else if a.paused_at.is_some() {
                "paused"
            } else if silent {
                "warn"
            } else {
                "recording"
            };
            r.lesson_id = Some(a.lesson.id.clone());
            let paused = a.paused_at.map_or(0, |p| now - p);
            r.sec = ((now - a.started_at - a.paused_ms - paused) / 1000).max(0);
            r.paused = a.paused_at.is_some();
            r.paused_sec = paused / 1000;
            r.nudge = a.nudge.showing;
            r.end_left = ((stop - now).max(0) + 999) / 1000;
            r.auto_stop_at = hhmm(a.stop_at);
        } else if let Some((id, _)) = &g.naming {
            r.mode = "naming";
            r.lesson_id = Some(id.clone());
            r.sec = if g.last_id.as_ref() == Some(id) { g.last_sec } else { 0 };
        } else if g.processing_until.is_some_and(|t| now < t) {
            r.mode = "processing";
            r.lesson_id = g.last_id.clone();
            r.sec = g.last_sec;
        } else if let Some(l) = g.cfg.token.as_ref().and_then(|_| pre_lesson(now, &g.lessons, &g.ended)) {
            r.mode = "pre";
            r.lesson_id = Some(l.id.clone());
            r.auto_start_at = hhmm(l.start_at - AUTO_START);
        } else if g.processing_until.is_some() {
            r.mode = "gone";
        }
        r
    }

    fn state_json(&self, g: &Inner, r: &RecView) -> Value {
        let (saved, uploaded) = r
            .lesson_id
            .as_deref()
            .filter(|_| r.mode != "pre")
            .and_then(|id| self.lesson_dir(id))
            .and_then(|d| recorder::read(&d).ok())
            .map_or((0, 0), |lf| (lf.segments.len(), lf.segments.iter().filter(|s| s.uploaded).count()));
        let mic = Some(self.shared.mic.lock().unwrap().clone())
            .filter(|m| !m.is_empty())
            .or_else(|| Some(g.cfg.mic.clone()).filter(|m| !m.is_empty()))
            .unwrap_or_else(|| g.default_mic.clone());
        json!({
            "teacher": if g.cfg.token.is_some() { g.cfg.teacher.clone().unwrap_or(json!({ "name": "" })) } else { Value::Null },
            "loggingIn": g.logging_in,
            "lessons": g.merged(),
            "rec": {
                "mode": r.mode,
                "lessonId": r.lesson_id,
                "sec": r.sec,
                "paused": r.paused,
                "pausedSec": r.paused_sec,
                "nudge": r.nudge,
                "endLeft": r.end_left,
                "autoStopAt": r.auto_stop_at,
                "autoStartAt": r.auto_start_at,
                "savedSegments": saved,
                "uploadedSegments": uploaded,
                "online": g.online,
            },
            "mics": g.mics,
            "mic": mic,
            "autostart": g.autostart,
            "fab": !g.cfg.hide_fab,
            "toast": g.toast,
            "selectedLessonId": g.selected,
            "version": self.app.package_info().version.to_string(),
            "updateReady": g.update_ready,
        })
    }

    pub fn state_now(&self) -> Value {
        let g = self.lock();
        let r = self.rec_view(&g, now_ms());
        self.state_json(&g, &r)
    }

    fn tray_status(&self, g: &Inner, r: &RecView, now: i64) -> String {
        if g.cfg.token.is_none() {
            return "未登录 · 打开菁仕课堂登录".into();
        }
        if let Some(a) = &g.active {
            if r.paused {
                return format!("❚❚ 已暂停 · 已录 {} · {}", hms(r.sec), a.lesson.title);
            }
            return format!("● 录制中 {} · {}", hms(r.sec), a.lesson.title);
        }
        let today = chrono::Utc::now().with_timezone(&shanghai()).format("%Y-%m-%d").to_string();
        let todays = g.lessons.iter().filter(|l| l.date == today);
        if let Some(l) = todays.clone().filter(|l| eligible(l, &g.ended) && l.start_at > now).min_by_key(|l| l.start_at) {
            return format!("下一节 {} · {} · 自动录制", l.start, l.title);
        }
        match todays.filter(|l| l.status == "done" && !l.copied).count() {
            0 => "今天的课都结束了".into(),
            n => format!("今天的课都结束了 · {n} 节总结未发送"),
        }
    }

    fn view(&self, g: &mut Inner, now: i64) -> View {
        let r = self.rec_view(g, now);
        let preview = r.mode == "pre" || g.preview_ui;
        if preview != g.preview_on {
            g.preview_on = preview;
            let _ = self.rec.send(Msg::Preview(preview));
        }
        let state = self.state_json(g, &r);
        // 计时由 Web 端从上次快照本地累加，秒数变化本身不推送，否则录音时每秒整份快照重发、三个窗口整页重绘
        let mut key = state.clone();
        if let Some(rec) = key.get_mut("rec").and_then(Value::as_object_mut) {
            rec.remove("sec");
            rec.remove("pausedSec");
            rec.remove("endLeft");
        }
        let s = key.to_string();
        let changed = s != g.last_json;
        g.last_json = s;
        g.selected = None; // 「选中某节课」只随一次快照发出
        let pill = matches!(r.mode, "pre" | "recording" | "paused" | "confirm" | "warn" | "quiet" | "ending" | "processing" | "naming");
        View {
            state: changed.then_some(state),
            status: self.tray_status(g, &r, now),
            title: if r.paused { "已暂停".into() } else if g.active.is_some() { hms(r.sec).trim_start_matches("00:").to_string() } else { String::new() },
            recording: g.active.is_some(),
            paused: r.paused,
            pill,
            naming: r.mode == "naming",
            // 有胶囊时胶囊就是入口，悬浮按钮让位
            fab: g.cfg.token.is_some() && !g.cfg.hide_fab && !pill,
            toast: g.toast.is_some(),
        }
    }

    /// 重新计算快照并同步到 Web / 托盘 / 窗口。不要在主线程调用。
    pub fn publish(self: &Arc<Self>) {
        let v = {
            let mut g = self.lock();
            self.view(&mut g, now_ms())
        };
        self.apply(v);
    }

    fn apply(self: &Arc<Self>, v: View) {
        if let Some(s) = v.state {
            let _ = self.app.emit("app-state", s);
        }
        let mut ui = self.ui.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tray) = self.app.tray_by_id("main") {
            if ui.status_item.is_none() || ui.recording != v.recording || ui.paused != v.paused {
                match build_menu(&self.app, &v.status, v.recording, v.paused) {
                    Ok((menu, item)) => {
                        let _ = tray.set_menu(Some(menu));
                        ui.status_item = Some(item);
                        ui.recording = v.recording;
                        ui.paused = v.paused;
                        ui.status = v.status.clone();
                    }
                    Err(e) => eprintln!("[tray] menu: {e}"),
                }
            }
            if ui.status != v.status {
                if let Some(item) = &ui.status_item {
                    let _ = item.set_text(&v.status);
                }
                ui.status = v.status;
            }
            if ui.title != v.title {
                #[cfg(target_os = "macos")]
                let _ = tray.set_title(Some(&v.title));
                ui.title = v.title;
            }
        }
        if v.pill != ui.pill {
            ui.pill = v.pill;
            if let Some(w) = self.app.get_webview_window("pill") {
                if v.pill {
                    let _ = w.show();
                } else {
                    // 让胶囊先播完淡出动画再藏窗口
                    let me = self.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(450)).await;
                        if !me.ui.lock().unwrap_or_else(|e| e.into_inner()).pill {
                            let _ = w.hide();
                        }
                    });
                }
            }
        }
        if v.naming != ui.naming {
            ui.naming = v.naming;
            // 填主题要打字：胶囊窗口平时不抢焦点，这时主动拿焦点
            if let (true, Some(w)) = (v.naming, self.app.get_webview_window("pill")) {
                let _ = w.set_focus();
            }
        }
        if v.fab != ui.fab {
            ui.fab = v.fab;
            if let Some(w) = self.app.get_webview_window("fab") {
                let _ = if v.fab { w.show() } else { w.hide() };
            }
        }
        if v.toast != ui.toast {
            ui.toast = v.toast;
            if let Some(w) = self.app.get_webview_window("toast") {
                let _ = if v.toast { w.show() } else { w.hide() };
            }
        }
    }

    // ---------- 供 commands 使用 ----------

    pub fn start_recording(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let now = now_ms();
        {
            let mut g = self.lock();
            if let Some(a) = &g.active {
                return if a.lesson.id == id { Ok(()) } else { Err("正在录制另一节课，请先结束".into()) };
            }
            let l = g.lessons.iter().find(|l| l.id == id).cloned().ok_or("课表里没有这节课")?;
            if matches!(l.status.as_str(), "done" | "processing") || self.lesson_dir(id).and_then(|d| recorder::read(&d).ok()).is_some_and(|lf| lf.finished) {
                return Err("这节课已经录完了".into());
            }
            if now < l.start_at - MANUAL_EARLY {
                return Err("最早可以提前 30 分钟开始录制".into());
            }
            self.start_session(&mut g, l, now)?;
        }
        self.publish();
        Ok(())
    }

    /// 老师在 App 里删掉一节课：只在本机隐藏，不改课表。正在录就停掉，本机录音整个删掉（不再上传、不出总结）；
    /// 云端已收到部分录音的，记进 discard，由 cloud::discard_pending 通知云端放弃（否则云端过两小时会用已有分段出报告）。
    pub fn delete_lesson(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let dir = self.lesson_dir(id).ok_or("课程编号无效")?;
        let now = now_ms();
        {
            let mut g = self.lock();
            if g.active.as_ref().is_some_and(|a| a.lesson.id == id) {
                self.stop_session(&mut g, now);
                g.processing_until = None;
            }
            if g.naming.as_ref().is_some_and(|(n, _)| n == id) {
                g.naming = None;
            }
            let cloud = is_merged(id) || dir.exists() || g.merged().iter().any(|l| l.id == id && matches!(l.status.as_str(), "recording" | "processing"));
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|e| format!("删除本机录音失败：{e}"))?;
            }
            g.orphans.retain(|(o, _)| o != id);
            g.ended.remove(id);
            g.lessons.retain(|l| l.id != id);
            g.adhoc.remove(id);
            if g.toast.as_ref().is_some_and(|t| t["lessonId"] == id) {
                g.toast = None;
            }
            g.cfg.hidden.retain(|_, t| now - *t < 30 * 24 * HOUR);
            g.cfg.hidden.insert(id.into(), now);
            if cloud && !g.cfg.discard.iter().any(|d| d == id) {
                g.cfg.discard.push(id.into());
            }
            self.save_cfg(&g.cfg);
        }
        self.publish();
        Ok(())
    }

    pub fn with_active(self: &Arc<Self>, f: impl FnOnce(&Core, &mut Inner, i64)) {
        {
            let mut g = self.lock();
            f(self, &mut g, now_ms());
        }
        self.publish();
    }

    /// 胶囊问「是否结束」时点了「继续录」：当作刚听到说话，重新按声音判断（不超过下课后 30 分钟）；暂停着的也接着录
    pub fn keep_going(&self, g: &mut Inner, now: i64) {
        if g.active.is_some() {
            self.shared.voice_at.store(now, Ordering::Relaxed);
            self.unpause(g, now);
        }
    }

    /// 暂停：录音线程照常切段、写静音，时间轴不断；「已录」停表
    pub fn pause(&self, g: &mut Inner, now: i64) {
        if let Some(a) = g.active.as_mut() {
            a.confirm = false;
            if a.paused_at.is_none() {
                a.paused_at = Some(now);
                a.nudge = Nudge::default();
                self.shared.paused.store(true, Ordering::Relaxed);
                if let Some(dir) = self.lesson_dir(&a.lesson.id) {
                    if let Err(e) = recorder::update(&dir, |lf| lf.paused_at = Some(now)) {
                        eprintln!("[engine] pause {}: {e}", a.lesson.id);
                    }
                }
            }
        }
    }

    /// 继续录（也用于收起「结束？」确认）：这段暂停记进 lesson.json，finish 时报给云端
    pub fn unpause(&self, g: &mut Inner, now: i64) {
        let Some(a) = g.active.as_mut() else { return };
        a.confirm = false;
        let Some(from) = a.paused_at.take() else { return };
        self.shared.paused.store(false, Ordering::Relaxed);
        a.paused_ms += now - from;
        a.nudge = Nudge::default();
        if let Some(dir) = self.lesson_dir(&a.lesson.id) {
            if let Err(e) = recorder::update(&dir, |lf| {
                lf.pauses.push((from, now));
                lf.paused_at = None;
            }) {
                eprintln!("[engine] pause {}: {e}", a.lesson.id);
            }
        }
        if g.toast.as_ref().is_some_and(|t| t["kind"] == "pause") {
            g.toast = None;
        }
    }

    /// 暂停提醒里点了「还在聊」：这次暂停不再提醒
    pub fn still_chatting(&self, g: &mut Inner) {
        if let Some(a) = g.active.as_mut() {
            a.nudge.quiet = true;
            a.nudge.showing = "";
        }
        if g.toast.as_ref().is_some_and(|t| t["kind"] == "pause") {
            g.toast = None;
        }
    }

    /// 每秒看一次暂停，满 10 分钟的那次同时弹通知
    fn check_pause(&self, g: &mut Inner, now: i64) {
        let Some(a) = g.active.as_mut() else { return };
        let Some(from) = a.paused_at else { return };
        if a.nudge.step(now, from, self.shared.voice_at.load(Ordering::Relaxed)) {
            let id = a.lesson.id.clone();
            g.toast = Some(json!({ "lessonId": id, "kind": "pause", "title": "已经暂停 10 分钟了", "body": "回来上课记得点「继续录」，暂停的这段不会录音" }));
        }
    }

    pub fn switch_mic(self: &Arc<Self>, name: String) {
        {
            let mut g = self.lock();
            g.cfg.mic = name.clone();
            self.save_cfg(&g.cfg);
            if let Some(a) = g.active.as_mut() {
                a.mic_since = now_ms(); // 换麦后重新计算「2 分钟无声」
            }
        }
        self.shared.heard.store(false, Ordering::Relaxed);
        *self.shared.mic.lock().unwrap() = name.clone();
        let _ = self.rec.send(Msg::Mic(name));
        self.publish();
    }

    pub fn refresh_mics(self: &Arc<Self>) {
        let (mics, default) = recorder::list_mics();
        {
            let mut g = self.lock();
            g.mics = mics;
            g.default_mic = default;
        }
        self.publish();
    }

    pub fn logout(self: &Arc<Self>) {
        {
            let mut g = self.lock();
            self.stop_session(&mut g, now_ms());
            clear_auth(&mut g);
            self.save_cfg(&g.cfg);
        }
        self.publish();
    }

    /// 401：只清掉这次请求用的那个 token（期间可能已经重新登录），不打断正在进行的录音。
    pub fn expire_token(self: &Arc<Self>, token: &str) {
        {
            let mut g = self.lock();
            if g.cfg.token.as_deref() != Some(token) {
                return;
            }
            clear_auth(&mut g);
            self.save_cfg(&g.cfg);
        }
        self.publish();
    }

    pub fn set_online(self: &Arc<Self>, online: bool) {
        let changed = {
            let mut g = self.lock();
            std::mem::replace(&mut g.online, online) != online
        };
        if changed {
            self.publish();
        }
    }

    /// 新课表到达：云端从 processing 变 done 且有总结 → 弹通知。
    /// token = 发请求时的登录；期间退出或换了账号，这份课表作废。
    pub fn set_lessons(self: &Arc<Self>, token: &str, lessons: Vec<Lesson>) {
        {
            let mut g = self.lock();
            if g.cfg.token.as_deref() != Some(token) {
                return;
            }
            let before: HashMap<String, String> = g.merged().into_iter().map(|l| (l.id, l.status)).collect();
            g.lessons = lessons.into_iter().filter(|l| !g.cfg.hidden.contains_key(&l.id)).collect();
            for l in g.merged() {
                let (true, Some(summary)) = (l.status == "done" && before.get(&l.id).is_some_and(|s| s == "processing"), &l.summary) else { continue };
                let student = l.title.rsplit(" · ").next().unwrap_or(&l.title);
                let title = match l.kind.as_deref() {
                    Some("merged") => continue, // 老师自己点的合并，不弹通知
                    Some("meeting") => format!("{}的会议纪要好了", l.title),
                    Some(_) => format!("{}的课堂总结好了", l.title),
                    None => format!("{student}今天的课堂总结好了"),
                };
                g.toast = Some(json!({ "lessonId": l.id, "title": title, "body": summary.split_whitespace().collect::<Vec<_>>().join(" ") }));
            }
        }
        self.publish();
    }
}

fn clear_auth(g: &mut Inner) {
    g.cfg.token = None;
    g.cfg.teacher = None;
    g.lessons.clear();
    g.toast = None;
    g.logging_in = false;
    g.login_gen += 1;
}

fn build_menu(app: &AppHandle, status: &str, recording: bool, paused: bool) -> tauri::Result<(Menu<Wry>, MenuItem<Wry>)> {
    let status = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "打开菁仕课堂", true, None::<&str>)?;
    let pause = if paused { MenuItem::with_id(app, "resume", "继续录制", true, None::<&str>)? } else { MenuItem::with_id(app, "pause", "暂停录制", true, None::<&str>)? };
    let stop = MenuItem::with_id(app, "stop", "结束录制…", true, None::<&str>)?;
    let adhoc = MenuItem::with_id(app, "adhoc", "随时录制", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let (s1, s2) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&status, &s1, &open];
    if recording {
        items.extend([&pause as &dyn IsMenuItem<Wry>, &stop]);
    } else {
        items.push(&adhoc);
    }
    items.extend([&settings as &dyn IsMenuItem<Wry>, &s2, &quit]);
    Ok((Menu::with_items(app, &items)?, status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::{LessonFile, Resampler, Segment};

    const T0: i64 = 1_760_515_200_000; // 某天 16:00

    fn lesson(id: &str, start: i64, mins: i64, status: &str) -> Lesson {
        Lesson { id: id.into(), start_at: start, end_at: start + mins * MIN, status: status.into(), ..Default::default() }
    }

    #[test]
    fn schedule_decisions() {
        let none = HashSet::new();
        let ls = vec![lesson("a", T0, 60, "upcoming")];
        assert_eq!(decide(T0 - 4 * MIN, &ls, None, &none), Action::Idle);
        assert_eq!(pre_lesson(T0 - 4 * MIN, &ls, &none).map(|l| l.id.as_str()), Some("a"));
        assert!(pre_lesson(T0 - 11 * MIN, &ls, &none).is_none());
        assert_eq!(decide(T0 - 3 * MIN, &ls, None, &none), Action::Start("a".into()));
        // 崩溃后晚开 App：上课中、下课后 10 分钟内都续录；之后不再录（下课后录多久由声音决定）
        assert_eq!(decide(T0 + 65 * MIN, &ls, None, &none), Action::Start("a".into()));
        assert_eq!(decide(T0 + 70 * MIN, &ls, None, &none), Action::Idle);
        // 临时取消、已结束、云端已处理的课不自动录
        assert_eq!(decide(T0, &[lesson("a", T0, 60, "cancelled")], None, &none), Action::Idle);
        assert_eq!(decide(T0, &[lesson("a", T0, 60, "done")], None, &none), Action::Idle);
        assert_eq!(decide(T0, &ls, None, &HashSet::from(["a".to_string()])), Action::Idle);
        // 录制中：到点停；没到点不动
        let a = ActiveRef { id: "a", start_at: T0, stop_at: T0 + 70 * MIN };
        assert_eq!(decide(T0 + 69 * MIN, &ls, Some(&a), &none), Action::Idle);
        assert_eq!(decide(T0 + 70 * MIN, &ls, Some(&a), &none), Action::Stop);
        // 连堂：下一节开录点切换；更早的课不会把正在录的抢走
        let two = vec![lesson("a", T0, 60, "upcoming"), lesson("b", T0 + 65 * MIN, 60, "upcoming"), lesson("z", T0 - 60 * MIN, 62, "upcoming")];
        assert_eq!(decide(T0 + 61 * MIN, &two, Some(&a), &none), Action::Idle);
        assert_eq!(decide(T0 + 62 * MIN, &two, Some(&a), &none), Action::Switch("b".into()));
        // 随时录制（别的电脑上录的、云端还是 recording）不会被这台电脑自动开录；最长 3 小时
        let adhoc = lesson("adhoc-0123456789abcdef", T0, 180, "recording");
        assert_eq!(decide(T0 + MIN, std::slice::from_ref(&adhoc), None, &none), Action::Idle);
        assert!(pre_lesson(T0 - 5 * MIN, std::slice::from_ref(&adhoc), &none).is_none());
        assert_eq!(stop_at_of(&adhoc), T0 + 180 * MIN);
        assert_eq!(stop_at_of(&ls[0]), T0 + 90 * MIN);
    }

    #[test]
    fn stop_by_voice() {
        let l = lesson("a", T0, 60, "upcoming");
        let end = T0 + 60 * MIN;
        // 下课前就安静了：从下课时间起算 3 分钟，再问 1 分钟
        assert_eq!(quiet_stop(&l, T0 + 50 * MIN), end + 4 * MIN);
        // 拖堂：最后一次说话后 3 分钟问、4 分钟停
        assert_eq!(quiet_stop(&l, end + 12 * MIN), end + 16 * MIN);
        // 一直有人说话 → 到下课后 30 分钟上限停
        assert_eq!(stop_at_of(&l).min(quiet_stop(&l, end + 29 * MIN)), end + 30 * MIN);
        // 随时录制不按声音停
        assert_eq!(quiet_stop(&lesson("adhoc-0123456789abcdef", T0, 180, "recording"), T0), i64::MAX);
    }

    #[test]
    fn pause_nudges() {
        let p = T0; // 暂停开始
        // 一直有人说话：1 分钟后提醒「好像开始讲课了」，之后不再变；10 分钟那次不再弹
        let mut n = Nudge::default();
        for s in 1..=60 {
            assert!(!n.step(p + s * 1000, p, p + s * 1000 - 500));
        }
        assert_eq!(n.showing, "");
        assert!(!n.step(p + 61_000, p, p + 60_500));
        assert_eq!(n.showing, "voice");
        assert!(!n.step(p + 10 * MIN, p, p + 10 * MIN));
        // 说话断了 10 秒以上重新算；没人说话满 10 分钟提醒一次并弹通知
        let mut n = Nudge::default();
        assert!(!n.step(p + 50_000, p, p + 30_000));
        assert!(!n.step(p + 70_000, p, p + 69_000));
        assert_eq!(n.showing, "");
        assert!(n.step(p + 10 * MIN, p, p));
        assert!(!n.step(p + 11 * MIN, p, p));
        assert_eq!(n.showing, "long");
        // 点了「还在聊」：这次暂停不再提醒
        let mut n = Nudge { quiet: true, ..Default::default() };
        assert!(!n.step(p + 20 * MIN, p, p + 20 * MIN));
        assert_eq!(n.showing, "");
    }

    #[test]
    fn fetch_schedule() {
        // T0 = 北京时间 16:00：刚拉过 → 等到明早 7:00（15 小时）
        assert_eq!(fetch_wait(T0, T0), 15 * 60 * MIN);
        // 昨天 16:00 拉过、今早 7:00 没拉成（关机）→ 已过期，5 分钟后重试
        assert_eq!(fetch_wait(T0, T0 - 24 * 60 * MIN), 5 * MIN);
        // 北京时间 6:00 拉过 → 当天 7:00 还要再拉一次
        assert_eq!(next_morning(T0 - 10 * 60 * MIN), T0 - 9 * 60 * MIN);
        assert_eq!(next_morning(T0 - 9 * 60 * MIN), T0 + 15 * 60 * MIN);
    }

    #[test]
    fn resampler_keeps_length() {
        for (from, chunk) in [(48_000u32, 480usize), (44_100, 441), (16_000, 160), (8_000, 333)] {
            let mut r = Resampler::new(from, 16_000);
            let mut out = Vec::new();
            for _ in 0..(from as usize / chunk) {
                r.process(&vec![0.5; chunk], &mut out);
            }
            let want = (from as usize / chunk * chunk) as f64 * 16_000.0 / from as f64;
            assert!((out.len() as f64 - want).abs() <= 1.0, "{from}: {} vs {want}", out.len());
            assert!(out[10..].iter().all(|&x| (x - 0.5).abs() < 1e-6));
        }
        // 30 秒 16 kHz 正弦 → 32 kbps MP3：约 120 KB，以 MPEG 帧同步字开头
        let mut enc = recorder::new_encoder().unwrap();
        let pcm: Vec<f32> = (0..480_000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        let mut mp3 = Vec::with_capacity(700_000);
        enc.encode_to_vec(mp3lame_encoder::MonoPcm(&pcm[..]), &mut mp3).unwrap();
        mp3.reserve(7200);
        enc.flush_to_vec::<mp3lame_encoder::FlushNoGap>(&mut mp3).unwrap();
        assert!(mp3[0] == 0xFF && mp3[1] & 0xE0 == 0xE0, "frame sync");
        assert!((110_000..135_000).contains(&mp3.len()), "{} bytes", mp3.len());
    }

    #[test]
    fn lesson_file_round_trip() {
        let dir = std::env::temp_dir().join(format!("classroom-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let l = lesson("recA", T0, 60, "upcoming");
        assert_eq!(recorder::begin(&dir, &l, T0, T0 + 70 * MIN).unwrap(), (1, T0));
        // 崩溃时落盘但未登记的段会被补登记，序号接着往后
        std::fs::write(recorder::seg_path(&dir, 1), b"abc").unwrap();
        assert_eq!(recorder::begin(&dir, &l, T0 + MIN, T0 + 70 * MIN).unwrap(), (2, T0));
        // 崩溃后下课才重启：收尾时也要补登记磁盘上的段
        std::fs::write(recorder::seg_path(&dir, 2), b"def").unwrap();
        recorder::end(&dir, T0 + 60 * MIN).unwrap();
        assert_eq!(recorder::read(&dir).unwrap().segments.iter().map(|s| s.seq).collect::<Vec<_>>(), [1, 2]);
        recorder::update(&dir, |lf| lf.segments.retain(|s| s.seq == 1)).unwrap();
        let want = LessonFile {
            lesson: l,
            started_at: T0,
            ended_at: Some(T0 + 60 * MIN),
            stop_at: T0 + 70 * MIN,
            segments: vec![Segment { seq: 1, sha256: recorder::sha256_hex(b"abc"), bytes: 3, uploaded: false }],
            finished: false,
            finished_at: None,
            failed: None,
            meta: None,
            pauses: vec![],
            paused_at: None,
        };
        assert_eq!(recorder::read(&dir).unwrap(), want);
        // 损坏的 lesson.json 不能被当成空记录覆盖
        std::fs::write(dir.join("lesson.json"), b"{oops").unwrap();
        assert!(recorder::update(&dir, |_| ()).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
