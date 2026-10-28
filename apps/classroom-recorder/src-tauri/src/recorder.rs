//! 麦克风 → 单声道 → 16 kHz → MP3 32 kbps，每 30 秒落盘一段；外加 lesson.json 读写。
//! cpal::Stream 不是 Send，所以整个录音器跑在一条专用线程里，用 channel 收命令和音频。
//! cpal 0.16 在 release（opt-level s + lto）下枚举设备会在 CoreAudio 里段错误，必须 ≥ 0.17。
//! 设备仍按 name() 匹配（设置里存的是名字）；0.17 起它被标为 deprecated，改用 id() 时要迁移已存的麦克风设置。
#![allow(deprecated)]

use crate::engine::Lesson;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use mp3lame_encoder::{Bitrate, Builder, Encoder, FlushNoGap, MonoPcm, Quality};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const OUT_RATE: u32 = 16_000;
const SEGMENT_SAMPLES: usize = 30 * OUT_RATE as usize;
// ponytail: 固定阈值（约 -42 dBFS）判断「听到声音」，教室底噪偏高/麦克风很灵敏时调这里。
const HEARD_RMS: f32 = 0.008;
// ponytail: 固定阈值（约 -40 dBFS）判断「有人在说话」，连续 2 块（0.25 秒）才算，滤掉键盘、关门这类单下的响声。
// 拖堂时该停不停 → 调高；老师小声讲课被问「是否结束」→ 调低。真实课堂录音攒够后按底噪实测再定。
const VOICE_RMS: f32 = 0.01;

pub enum Msg {
    Start { dir: PathBuf, seq: u32, reply: Sender<Result<(), String>> },
    Stop { reply: Sender<()> },
    Mic(String),
    Preview(bool),
    Audio(Vec<f32>, u32),
    StreamError(String),
}

/// 录音线程与引擎共享的少量状态（不经过 Inner 锁，避免互相等待）。
#[derive(Default)]
pub struct Shared {
    pub heard: AtomicBool,
    /// 最近一次听到有人说话的时间（ms）；开录、老师点「继续录」时也会刷新
    pub voice_at: AtomicI64,
    /// 老师点了暂停：照常切段（时间轴不断），但写进去的是静音；音量照看，用来提醒「好像开始讲课了」
    pub paused: AtomicBool,
    pub mic: Mutex<String>, // 实际打开的设备名
    pub kick_upload: tokio::sync::Notify,
}

pub fn list_mics() -> (Vec<String>, String) {
    let host = cpal::default_host();
    let names = host
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    let default = host.default_input_device().and_then(|d| d.name().ok()).unwrap_or_default();
    (names, default)
}

pub fn spawn(app: AppHandle, shared: Arc<Shared>, mic: String) -> Sender<Msg> {
    let (tx, rx) = std::sync::mpsc::channel();
    let me = tx.clone();
    std::thread::Builder::new()
        .name("recorder".into())
        .spawn(move || Rec { app, shared, tx: me, mic, stream: None, session: None, preview: false, rs: None, lvl: (0.0, 0), voiced: 0 }.run(rx))
        .expect("spawn recorder thread");
    tx
}

struct Session {
    // 录制期间阻止系统睡眠。放在录音线程里创建/释放：Windows 的 SetThreadExecutionState 按线程生效
    _awake: Option<keepawake::KeepAwake>,
    dir: PathBuf,
    seq: u32,
    enc: Encoder,
    mp3: Vec<u8>,
    samples: usize,
}

struct Rec {
    app: AppHandle,
    shared: Arc<Shared>,
    tx: Sender<Msg>,
    mic: String,
    stream: Option<cpal::Stream>,
    session: Option<Session>,
    preview: bool,
    rs: Option<(u32, Resampler)>,
    lvl: (f64, usize),
    voiced: u32,
}

impl Rec {
    fn run(mut self, rx: Receiver<Msg>) {
        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(Msg::Start { dir, seq, reply }) => {
                    let awake = keepawake::Builder::default().idle(true).reason("正在录制课堂").app_name("菁仕课堂").app_reverse_domain("asia.jsjy.classroom").create();
                    let r = new_encoder().map(|enc| Session { _awake: awake.ok(), dir, seq, enc, mp3: Vec::new(), samples: 0 });
                    let r = r.and_then(|s| {
                        self.session = Some(s);
                        self.sync_stream()
                    });
                    if r.is_err() {
                        self.session = None;
                    }
                    let _ = reply.send(r);
                }
                Ok(Msg::Stop { reply }) => {
                    if let Some(mut s) = self.session.take() {
                        self.cut(&mut s);
                    }
                    let _ = self.sync_stream();
                    let _ = reply.send(());
                }
                Ok(Msg::Mic(name)) => {
                    self.mic = name;
                    self.stream = None;
                    let _ = self.sync_stream();
                }
                Ok(Msg::Preview(on)) => {
                    self.preview = on;
                    let _ = self.sync_stream();
                }
                Ok(Msg::Audio(buf, rate)) => self.on_audio(&buf, rate),
                Ok(Msg::StreamError(e)) => {
                    // 设备断开等：丢掉旧流，按名字重开，找不到就落到系统默认麦克风，录音会话不中断。
                    eprintln!("[recorder] stream error: {e}");
                    self.stream = None;
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = self.sync_stream();
                }
                Err(RecvTimeoutError::Timeout) => {
                    if self.stream.is_none() {
                        let _ = self.sync_stream(); // 没有可用设备时每 2 秒重试
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn sync_stream(&mut self) -> Result<(), String> {
        let want = self.session.is_some() || self.preview;
        if !want {
            self.stream = None;
            return Ok(());
        }
        if self.stream.is_some() {
            return Ok(());
        }
        let (stream, name) = open_stream(&self.mic, self.tx.clone())?;
        self.stream = Some(stream);
        *self.shared.mic.lock().unwrap() = name;
        Ok(())
    }

    fn on_audio(&mut self, buf: &[f32], rate: u32) {
        // 电平：约 8 Hz 发一次 level，同时记录「听到声音」。
        for &x in buf {
            self.lvl.0 += (x * x) as f64;
        }
        self.lvl.1 += buf.len();
        if self.lvl.1 >= (rate / 8) as usize {
            let rms = (self.lvl.0 / self.lvl.1 as f64).sqrt() as f32;
            self.lvl = (0.0, 0);
            if rms >= HEARD_RMS {
                self.shared.heard.store(true, Ordering::Relaxed);
            }
            self.voiced = if rms >= VOICE_RMS { self.voiced.saturating_add(1) } else { 0 };
            if self.voiced >= 2 {
                self.shared.voice_at.store(crate::engine::now_ms(), Ordering::Relaxed);
            }
            let _ = self.app.emit("level", level_of(rms));
        }
        let Some(s) = self.session.as_mut() else { return };
        if self.rs.as_ref().is_none_or(|(r, _)| *r != rate) {
            self.rs = Some((rate, Resampler::new(rate, OUT_RATE)));
        }
        let mut out = Vec::with_capacity(buf.len() * OUT_RATE as usize / rate as usize + 2);
        self.rs.as_mut().unwrap().1.process(buf, &mut out);
        if self.shared.paused.load(Ordering::Relaxed) {
            out.fill(0.0);
        }
        s.mp3.reserve(out.len() * 5 / 4 + 7200);
        if let Err(e) = s.enc.encode_to_vec(MonoPcm(&out[..]), &mut s.mp3) {
            eprintln!("[recorder] encode: {e:?}");
        }
        s.samples += out.len();
        if s.samples >= SEGMENT_SAMPLES {
            let mut s = self.session.take().unwrap();
            self.cut(&mut s);
            self.session = Some(s);
        }
    }

    /// 把当前缓冲刷成一个 MP3 段：先写文件（tmp + rename），再记进 lesson.json。
    fn cut(&mut self, s: &mut Session) {
        s.mp3.reserve(7200);
        let _ = s.enc.flush_to_vec::<FlushNoGap>(&mut s.mp3);
        if s.mp3.is_empty() {
            return;
        }
        let bytes = std::mem::take(&mut s.mp3);
        s.samples = 0;
        match add_segment(&s.dir, s.seq, &bytes) {
            Ok(()) => {
                s.seq += 1;
                self.shared.kick_upload.notify_one();
            }
            // 写盘失败（磁盘满等）就把数据留在缓冲里，30 秒后下一次切段时一起再试。
            Err(e) => {
                eprintln!("[recorder] save segment {}: {e}", s.seq);
                s.mp3 = bytes;
            }
        }
    }
}

pub fn new_encoder() -> Result<Encoder, String> {
    let mut b = Builder::new().ok_or("无法初始化 MP3 编码器")?;
    b.set_num_channels(1).map_err(|e| format!("{e:?}"))?;
    b.set_sample_rate(OUT_RATE).map_err(|e| format!("{e:?}"))?;
    b.set_brate(Bitrate::Kbps32).map_err(|e| format!("{e:?}"))?;
    b.set_quality(Quality::Good).map_err(|e| format!("{e:?}"))?;
    b.set_to_write_vbr_tag(false).map_err(|e| format!("{e:?}"))?; // 分段直接拼接，不要开头的 Xing/Info 占位帧
    b.build().map_err(|e| format!("{e:?}"))
}

fn level_of(rms: f32) -> f32 {
    if rms <= 0.0 {
        return 0.0;
    }
    ((20.0 * rms.log10() + 60.0) / 50.0).clamp(0.0, 1.0) // -60 dBFS → 0，-10 dBFS → 1
}

fn open_stream(mic: &str, tx: Sender<Msg>) -> Result<(cpal::Stream, String), String> {
    let host = cpal::default_host();
    let found = if mic.is_empty() {
        None
    } else {
        host.input_devices().ok().and_then(|mut it| it.find(|d| d.name().is_ok_and(|n| n == mic)))
    };
    let dev = found.or_else(|| host.default_input_device()).ok_or("没有找到可用的麦克风")?;
    let name = dev.name().unwrap_or_default();
    let cfg = dev.default_input_config().map_err(|e| format!("麦克风不可用：{e}"))?;
    let (rate, ch, fmt) = (cfg.sample_rate(), cfg.channels() as usize, cfg.sample_format());
    let cfg: cpal::StreamConfig = cfg.into();
    let stream = match fmt {
        SampleFormat::F32 => build::<f32>(&dev, &cfg, ch, rate, tx),
        SampleFormat::I16 => build::<i16>(&dev, &cfg, ch, rate, tx),
        SampleFormat::U16 => build::<u16>(&dev, &cfg, ch, rate, tx),
        SampleFormat::I32 => build::<i32>(&dev, &cfg, ch, rate, tx),
        f => return Err(format!("不支持的采样格式 {f:?}")),
    }?;
    stream.play().map_err(|e| format!("麦克风启动失败：{e}"))?;
    Ok((stream, name))
}

fn build<T: SizedSample + Send + 'static>(
    dev: &cpal::Device,
    cfg: &cpal::StreamConfig,
    ch: usize,
    rate: u32,
    tx: Sender<Msg>,
) -> Result<cpal::Stream, String>
where
    f32: FromSample<T>,
{
    let etx = tx.clone();
    dev.build_input_stream(
        cfg,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mono = data.chunks(ch).map(|f| f.iter().map(|&s| s.to_sample::<f32>()).sum::<f32>() / ch as f32).collect();
            let _ = tx.send(Msg::Audio(mono, rate));
        },
        move |e| {
            let _ = etx.send(Msg::StreamError(e.to_string()));
        },
        None,
    )
    .map_err(|e| format!("无法打开麦克风：{e}"))
}

/// 线性插值重采样，跨块保持相位。
pub struct Resampler {
    step: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self { step: from as f64 / to as f64, pos: 0.0, prev: 0.0 }
    }
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        // 虚拟缓冲 = [prev, input...]，下标 i 与 i+1 之间插值
        let n = input.len() as f64;
        while self.pos < n {
            let i = self.pos as usize;
            let f = (self.pos - i as f64) as f32;
            let a = if i == 0 { self.prev } else { input[i - 1] };
            out.push(a + (input[i] - a) * f);
            self.pos += self.step;
        }
        self.pos -= n;
        if let Some(&l) = input.last() {
            self.prev = l;
        }
    }
}

// ---------- lesson.json ----------

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LessonFile {
    pub lesson: Lesson,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub stop_at: i64,
    pub segments: Vec<Segment>,
    pub finished: bool,
    pub finished_at: Option<i64>,
    /// 云端永久拒收（NOT_YOUR_LESSON / LESSON_NOT_FOUND）：不再重试，文件保留 7 天备查
    pub failed: Option<String>,
    /// 随时录制结束时老师填的主题和类型；填好（或 10 分钟后按默认）才提交 finish
    pub meta: Option<AdhocMeta>,
    /// 老师点了暂停的时段（ms），finish 时报给云端，档案里标成「暂停」
    pub pauses: Vec<(i64, i64)>,
    /// 正在暂停（开始时间）：崩溃重启后续录时接着暂停，不能悄悄录上真声音
    pub paused_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AdhocMeta {
    pub topic: String,
    /// "adhoc" = 课程（出家长总结 + 学情报告）；"meeting" = 会议（出会议纪要）
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Segment {
    pub seq: u32,
    pub sha256: String,
    pub bytes: u64,
    pub uploaded: bool,
}

// ponytail: 所有 lesson.json 共用一把全局锁，写入频率很低（每 30 秒级），够用。
static STORE: Mutex<()> = Mutex::new(());

pub fn seg_path(dir: &Path, seq: u32) -> PathBuf {
    dir.join(format!("{seq:05}.mp3"))
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

/// 读 lesson.json；不存在 → 默认值；存在但解析失败 → 报错（绝不拿空记录覆盖）。
pub fn read(dir: &Path) -> std::io::Result<LessonFile> {
    match std::fs::read(dir.join("lesson.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(std::io::Error::other),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LessonFile::default()),
        Err(e) => Err(e),
    }
}

pub fn update<R>(dir: &Path, f: impl FnOnce(&mut LessonFile) -> R) -> std::io::Result<R> {
    let _g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let mut lf = read(dir)?;
    let r = f(&mut lf);
    std::fs::create_dir_all(dir)?;
    write_atomic(&dir.join("lesson.json"), &serde_json::to_vec_pretty(&lf)?)?;
    Ok(r)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn add_segment(dir: &Path, seq: u32, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic(&seg_path(dir, seq), bytes)?;
    let seg = Segment { seq, sha256: sha256_hex(bytes), bytes: bytes.len() as u64, uploaded: false };
    update(dir, |lf| {
        lf.segments.retain(|s| s.seq != seq);
        lf.segments.push(seg);
    })
}

/// 补登记崩溃时已落盘（mp3 已改名）但还没写进 lesson.json 的段。
fn adopt_disk(dir: &Path, lf: &mut LessonFile) {
    let on_disk: Vec<u32> = std::fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".mp3")?.parse().ok()).collect())
        .unwrap_or_default();
    for seq in on_disk {
        if !lf.segments.iter().any(|s| s.seq == seq) {
            if let Ok(b) = std::fs::read(seg_path(dir, seq)) {
                lf.segments.push(Segment { seq, sha256: sha256_hex(&b), bytes: b.len() as u64, uploaded: false });
            }
        }
    }
    lf.segments.sort_by_key(|s| s.seq);
}

/// 崩溃遗留的录音收尾：先补登记磁盘上的段，再记结束时间交给上传。
pub fn end(dir: &Path, ended_at: i64) -> std::io::Result<()> {
    update(dir, |lf| {
        adopt_disk(dir, lf);
        lf.ended_at = Some(ended_at);
    })
}

/// 开始/续录一节课：写入课程信息，补登记磁盘上的段，返回下一个序号和首次开录时间。
pub fn begin(dir: &Path, lesson: &Lesson, now: i64, stop_at: i64) -> std::io::Result<(u32, i64)> {
    std::fs::create_dir_all(dir)?;
    update(dir, |lf| {
        adopt_disk(dir, lf);
        lf.lesson = lesson.clone();
        lf.ended_at = None;
        lf.stop_at = lf.stop_at.max(stop_at); // 续录时保留之前「再录 15 分钟」
        if lf.started_at == 0 {
            lf.started_at = now;
        }
        (lf.segments.last().map_or(1, |s| s.seq + 1), lf.started_at)
    })
}
