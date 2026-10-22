use crate::engine::{now_ms, update_idle, Core};
use std::sync::Arc;
use std::time::Duration;
use tauri_plugin_updater::UpdaterExt;

/// 自动更新：开机 1 分钟后、之后每小时去 app.jsjy.asia 看一次 latest.json（静态文件，几乎不花钱）。
/// 有新版本就下载，只在空闲时（没在录、前后 30 分钟没课、没在登录或填主题）安装并重启，老师不用点任何东西。
/// 安装包用发版私钥签名，App 内置公钥校验，签名不对不会装。
pub async fn update_loop(core: Arc<Core>) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    loop {
        if let Err(e) = try_update(&core).await {
            eprintln!("[update] {e}");
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

fn idle(core: &Core) -> bool {
    let g = core.lock();
    !g.logging_in && g.naming.is_none() && update_idle(now_ms(), &g.merged(), g.active.is_some())
}

async fn try_update(core: &Arc<Core>) -> Result<(), String> {
    if !idle(core) {
        return Ok(());
    }
    let Some(update) = core.app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    if !idle(core) {
        return Ok(()); // 下载期间到了课前，下个小时再装
    }
    eprintln!("[update] {} → {}", update.current_version, update.version);
    update.install(bytes).map_err(|e| e.to_string())?;
    core.app.restart();
}
