//! 麦克风 → 单声道 → WebRTC 声音处理（sonora：高通、低档降噪、自动增益、降到 16 kHz）→ MP3 32 kbps，每 30 秒落盘一段；外加 lesson.json 读写。
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
use sonora::config::{GainController2, HighPassFilter, NoiseSuppression, NoiseSuppressionLevel};
use sonora::{AudioProcessing, Config, StreamConfig};
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
    /// 交错的多声道采样、采样率、声道数
    Audio(Vec<f32>, u32, usize),
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
        .spawn(move || Rec { app, shared, tx: me, mic, stream: None, session: None, preview: false, lvl: (0.0, 0), voiced: 0 }.run(rx))
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
    clean: Cleaner,
    probe: Probe,
}

struct Rec {
    app: AppHandle,
    shared: Arc<Shared>,
    tx: Sender<Msg>,
    mic: String,
    stream: Option<cpal::Stream>,
    session: Option<Session>,
    preview: bool,
    lvl: (f64, usize),
    voiced: u32,
}

impl Rec {
    fn run(mut self, rx: Receiver<Msg>) {
        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(Msg::Start { dir, seq, reply }) => {
                    let awake = keepawake::Builder::default().idle(true).reason("正在录制课堂").app_name("菁仕课堂").app_reverse_domain("asia.jsjy.classroom").create();
                    let r = new_encoder().map(|enc| Session { _awake: awake.ok(), dir, seq, enc, mp3: Vec::new(), samples: 0, clean: Cleaner::new(), probe: Probe::default() });
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
                Ok(Msg::Audio(buf, rate, ch)) => self.on_audio(&buf, rate, ch),
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

    fn on_audio(&mut self, raw: &[f32], rate: u32, ch: usize) {
        let buf: Vec<f32> = raw.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect();
        // 电平：约 8 Hz 发一次 level，同时记录「听到声音」。看的是处理前的原始音量，自动结束、空录音判断不受增益影响。
        for &x in &buf {
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
        s.probe.add(raw, rate, ch);
        let mut out = Vec::with_capacity(buf.len() * OUT_RATE as usize / rate as usize + 160);
        s.clean.process(&buf, rate, &mut out);
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
        let mic = s.probe.stats(&self.shared.mic.lock().unwrap());
        match add_segment(&s.dir, s.seq, &bytes, mic) {
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
            let _ = tx.send(Msg::Audio(data.iter().map(|&s| s.to_sample::<f32>()).collect(), rate, ch));
        },
        move |e| {
            let _ = etx.send(Msg::StreamError(e.to_string()));
        },
        None,
    )
    .map_err(|e| format!("无法打开麦克风：{e}"))
}

/// WebRTC 声音处理（Chrome 同款，sonora 是它的纯 Rust 移植）：高通去低频轰鸣、低档降噪只去风扇空调这类持续底噪、
/// 自动增益 AGC2（RNN 判断有人说话时才调，默认最多 +50 dB、底噪不超过 -50 dBFS，自带限幅），同时降到 16 kHz。
/// 每节课新建一个，增益从头适应。
pub struct Cleaner {
    apm: AudioProcessing,
    rate: u32,
    /// 采样率不是 100 的整数倍（如 22050）时，10 ms 凑不成整数个采样，先线性降到 16 kHz 再处理
    pre: Option<Resampler>,
    pend: Vec<f32>,
}

impl Cleaner {
    pub fn new() -> Self {
        let config = Config {
            high_pass_filter: Some(HighPassFilter::default()),
            noise_suppression: Some(NoiseSuppression { level: NoiseSuppressionLevel::Low, ..Default::default() }),
            gain_controller2: Some(GainController2 { adaptive_digital: Some(Default::default()), ..Default::default() }),
            ..Default::default()
        };
        let apm = AudioProcessing::builder().config(config).capture_config(StreamConfig::new(OUT_RATE, 1)).build();
        Self { apm, rate: 0, pre: None, pend: Vec::new() }
    }

    /// 单声道 `rate` Hz 进，处理好的 16 kHz 出（追加到 out）；不满 10 ms 的尾巴留到下一次。
    pub fn process(&mut self, input: &[f32], rate: u32, out: &mut Vec<f32>) {
        if rate != self.rate {
            self.rate = rate;
            self.pend.clear();
            self.pre = (rate % 100 != 0).then(|| Resampler::new(rate, OUT_RATE));
        }
        match &mut self.pre {
            Some(r) => r.process(input, &mut self.pend),
            None => self.pend.extend_from_slice(input),
        }
        let in_cfg = StreamConfig::new(if self.pre.is_some() { OUT_RATE } else { rate }, 1);
        let out_cfg = StreamConfig::new(OUT_RATE, 1);
        let (n, m) = (in_cfg.num_frames(), out_cfg.num_frames());
        let mut done = 0;
        while self.pend.len() - done >= n {
            let at = out.len();
            out.resize(at + m, 0.0);
            if let Err(e) = self.apm.process_capture_f32_with_config(&[&self.pend[done..done + n]], &in_cfg, &out_cfg, &mut [&mut out[at..]]) {
                eprintln!("[recorder] apm: {e}");
            }
            done += n;
        }
        self.pend.drain(..done);
    }
}

/// 每个声道的原始音量和前两路的相关性，随 finish 报给云端：
/// Windows 阵列麦有一路是空的（某路 dB 很低）或两路反相（corr≈-1）时，取平均会让声音变小甚至抵消。
#[derive(Default)]
struct Probe {
    rate: u32,
    sq: Vec<f64>,
    cross: f64,
    frames: u64,
}

impl Probe {
    fn add(&mut self, raw: &[f32], rate: u32, ch: usize) {
        if self.sq.len() != ch || self.rate != rate {
            *self = Probe { rate, sq: vec![0.0; ch], ..Default::default() };
        }
        for f in raw.chunks_exact(ch) {
            self.sq.iter_mut().zip(f).for_each(|(s, &x)| *s += (x * x) as f64);
            if ch > 1 {
                self.cross += (f[0] * f[1]) as f64;
            }
        }
        self.frames += (raw.len() / ch) as u64;
    }

    fn stats(&self, name: &str) -> Option<MicStats> {
        if self.frames == 0 {
            return None;
        }
        let db = |s: f64| (10.0 * (s / self.frames as f64).log10()).max(-120.0) as f32;
        let corr = (self.sq.len() > 1 && self.sq[0] > 0.0 && self.sq[1] > 0.0).then(|| (self.cross / (self.sq[0] * self.sq[1]).sqrt()) as f32);
        Some(MicStats {
            name: name.into(),
            os: std::env::consts::OS.into(),
            rate: self.rate,
            ch_db: self.sq.iter().map(|&s| db(s)).collect(),
            corr,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MicStats {
    pub name: String,
    pub os: String,
    pub rate: u32,
    /// 每个声道整节课的平均音量（dBFS，处理前）
    pub ch_db: Vec<f32>,
    /// 第 1、2 路的相关系数：≈1 两路一样，≈0 一路空/各录各的，≈-1 反相
    pub corr: Option<f32>,
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
    /// 0.1.12 起：停止后整节课拼成一个 MP3 直传成功、还没 finish；云端说没收全就清掉重传
    pub audio: Option<Audio>,
    /// 0.1.13 的保险上传时间；0.1.14 起改成分块上传，不再用，只为读旧文件保留
    pub early_at: Option<i64>,
    /// 上传连着失败了几次、最后一次的原因（下次要签名时报给云端，方便查）
    pub upload_fails: u32,
    pub upload_error: String,
    /// 0.1.14 起上课时每 5 分钟传一块：云端已收到的块。字节数和本机这一块的分段加起来对不上（续录后最后一块变长）就重传
    pub parts: Vec<Part>,
    /// 第一块签名成功 = 云端已建档，之后的块签名不查库
    pub parts_registered: bool,
    /// 有块没能一次传上 = 网不好：下课后不再整段直传，直接让云端用块拼
    pub part_trouble: bool,
    /// 麦克风各声道音量，每次切段刷新（0.1.15 起）
    pub mic: Option<MicStats>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Part {
    pub n: u32,
    pub bytes: u64,
}

/// 一块 = 10 个 30 秒分段（5 分钟，32 kbps 约 1.2 MB）；第 n 块是分段 n*10+1 … n*10+10
pub const PART_SEGS: u32 = 10;

pub fn part_of(seq: u32) -> u32 {
    seq.saturating_sub(1) / PART_SEGS
}

/// 本机这一块的分段加起来多少字节（不读文件）
pub fn part_bytes(lf: &LessonFile, n: u32) -> u64 {
    lf.segments.iter().filter(|s| part_of(s.seq) == n).map(|s| s.bytes).sum()
}

/// 能传的块：录完的课全部；还在录的只要满 10 段的（最后一块还在长）
pub fn ready_parts(lf: &LessonFile) -> Vec<u32> {
    let Some(max) = lf.segments.iter().map(|s| s.seq).max() else { return vec![] };
    let mut ns: Vec<u32> = lf.segments.iter().map(|s| part_of(s.seq)).collect();
    ns.sort_unstable();
    ns.dedup();
    ns.retain(|&n| lf.ended_at.is_some() || max >= (n + 1) * PART_SEGS);
    ns
}

/// 还没传、或内容变了的块
pub fn pending_parts(lf: &LessonFile) -> Vec<u32> {
    ready_parts(lf).into_iter().filter(|&n| !lf.parts.iter().any(|p| p.n == n && p.bytes == part_bytes(lf, n))).collect()
}

/// (云端已有的字节, 本机一共的字节)：整段直传成功了就算全有
pub fn cloud_bytes(lf: &LessonFile) -> (u64, u64) {
    let total = lf.segments.iter().map(|s| s.bytes).sum();
    if lf.audio.is_some() || lf.finished {
        return (total, total);
    }
    let up = lf.parts.iter().filter(|p| p.bytes == part_bytes(lf, p.n)).map(|p| p.bytes).sum::<u64>();
    (up.min(total), total)
}

/// 第 n 块的内容：这一块的分段按序号拼接，和整节拼接一样校验
pub fn part_audio(dir: &Path, lf: &LessonFile, n: u32) -> std::io::Result<Vec<u8>> {
    concat_segs(dir, lf.segments.iter().filter(|s| part_of(s.seq) == n))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Audio {
    pub sha256: String,
    pub bytes: u64,
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

/// 已录的分段按序号直接拼成一个 MP3（帧可直接拼接，云端原来也是这么合并的）
pub fn concat(dir: &Path, lf: &LessonFile) -> std::io::Result<Vec<u8>> {
    concat_segs(dir, lf.segments.iter())
}

fn concat_segs<'a>(dir: &Path, segs: impl Iterator<Item = &'a Segment>) -> std::io::Result<Vec<u8>> {
    let mut segs: Vec<&Segment> = segs.collect();
    segs.sort_by_key(|s| s.seq);
    let mut out = Vec::with_capacity(segs.iter().map(|s| s.bytes as usize).sum());
    for s in segs {
        let bytes = std::fs::read(seg_path(dir, s.seq))?;
        if bytes.len() as u64 != s.bytes || sha256_hex(&bytes) != s.sha256 {
            return Err(std::io::Error::other(format!("录音分段 {} 校验失败", s.seq)));
        }
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn add_segment(dir: &Path, seq: u32, bytes: &[u8], mic: Option<MicStats>) -> std::io::Result<()> {
    write_atomic(&seg_path(dir, seq), bytes)?;
    let seg = Segment { seq, sha256: sha256_hex(bytes), bytes: bytes.len() as u64, uploaded: false };
    update(dir, |lf| {
        lf.segments.retain(|s| s.seq != seq);
        lf.segments.push(seg);
        lf.mic = mic.or(lf.mic.take());
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
        lf.audio = None; // 续录了，之前传的整段不算数
        lf.stop_at = lf.stop_at.max(stop_at); // 续录时保留之前「再录 15 分钟」
        if lf.started_at == 0 {
            lf.started_at = now;
        }
        (lf.segments.last().map_or(1, |s| s.seq + 1), lf.started_at)
    })
}
