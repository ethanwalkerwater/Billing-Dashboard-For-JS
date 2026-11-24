use crate::engine::{now_ms, Core, MIN};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri_plugin_updater::{Update, UpdaterExt};

/// 更新：打开 App 时（启动、从菜单栏 / 托盘 / Dock 打开主窗口）查一次 latest.json，24 小时内查过就不再查；
/// 设置里「检查更新」随时手动查。latest.json 是 CloudBase 静态文件，不走云函数，不花资源点。
/// 有新版就在后台下载好，标题栏提示「重启更新」，老师点了才装（录课中不能装），不强制。
/// 安装包用发版私钥签名，App 内置公钥校验，签名不对不会装。
static PENDING: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
static CHECKED_AT: AtomicI64 = AtomicI64::new(0);
static CHECKING: AtomicBool = AtomicBool::new(false);
const EVERY: i64 = 24 * 60 * MIN;

/// 启动时：等 30 秒（开机自启时网络可能还没好）再查
pub async fn on_start(core: Arc<Core>) {
    tokio::time::sleep(Duration::from_secs(30)).await;
    on_open(&core);
}

/// 打开主窗口时：24 小时内查过（或已下载好新版）就跳过
pub fn on_open(core: &Arc<Core>) {
    if now_ms() - CHECKED_AT.load(Ordering::Relaxed) < EVERY || core.lock().update_ready.is_some() {
        return;
    }
    let c = core.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check(&c).await {
            eprintln!("[update] {e}");
        }
    });
}

/// 查一次，有新版就下载好等老师点。返回给设置里显示的一句话。
pub async fn check(core: &Arc<Core>) -> Result<String, String> {
    if let Some(v) = core.lock().update_ready.clone() {
        return Ok(format!("新版本 {v} 已下载好"));
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return Ok("正在检查…".into());
    }
    let res = download(core).await;
    CHECKING.store(false, Ordering::SeqCst);
    res
}

async fn download(core: &Arc<Core>) -> Result<String, String> {
    let e = |e: tauri_plugin_updater::Error| e.to_string();
    let update = core.app.updater().map_err(e)?.check().await.map_err(|_| "连不上更新服务器，请稍后再试")?;
    let Some(update) = update else {
        CHECKED_AT.store(now_ms(), Ordering::Relaxed);
        return Ok("已是最新版本".into());
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|_| "新版本下载失败，请稍后再试")?;
    CHECKED_AT.store(now_ms(), Ordering::Relaxed);
    let v = update.version.clone();
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
    core.lock().update_ready = Some(v.clone());
    core.publish();
    Ok(format!("新版本 {v} 已下载好"))
}

/// 老师点「重启更新」：录课 / 填主题时不装；装完重启（Windows 安装程序会自己关掉并重开 App）
pub fn install(core: &Arc<Core>) -> Result<(), String> {
    {
        let g = core.lock();
        if g.active.is_some() || g.naming.is_some() {
            return Err("正在录制，录完再更新".into());
        }
    }
    let (update, bytes) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take().ok_or("没有待安装的新版本")?;
    if let Err(err) = update.install(bytes) {
        core.lock().update_ready = None; // 下次打开时重新下载
        CHECKED_AT.store(0, Ordering::Relaxed);
        core.publish();
        return Err(format!("安装失败：{err}"));
    }
    core.shutdown();
    core.app.restart();
}
