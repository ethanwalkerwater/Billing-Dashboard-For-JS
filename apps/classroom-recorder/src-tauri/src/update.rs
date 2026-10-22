use crate::engine::Core;
use std::sync::Arc;
use tauri_plugin_updater::UpdaterExt;

/// 只在老师点设置里的「检查更新」时查（不定时检查）：去 app.jsjy.asia 读 latest.json，有新版就下载、安装并重启。
/// 安装包用发版私钥签名，App 内置公钥校验，签名不对不会装。正在录课 / 填主题 / 登录时不装，免得重启打断。
pub async fn check_now(core: &Arc<Core>) -> Result<String, String> {
    let busy = || {
        let g = core.lock();
        g.active.is_some() || g.naming.is_some() || g.logging_in
    };
    let e = |e: tauri_plugin_updater::Error| e.to_string();
    let Some(update) = core.app.updater().map_err(e)?.check().await.map_err(|_| "连不上更新服务器，请稍后再试")? else {
        return Ok("已是最新版本".into());
    };
    let later = format!("有新版本 {}，录完这节课后再点一次「检查更新」", update.version);
    if busy() {
        return Ok(later);
    }
    let bytes = update.download(|_, _| {}, || {}).await.map_err(e)?;
    if busy() {
        return Ok(later); // 下载期间开始录了
    }
    eprintln!("[update] {} → {}", update.current_version, update.version);
    update.install(bytes).map_err(e)?;
    core.app.restart();
}
