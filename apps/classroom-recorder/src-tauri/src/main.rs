#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cloud;
mod engine;
mod recorder;
mod update;

use engine::Core;
use serde_json::Value;
use std::sync::Arc;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

type St<'a> = tauri::State<'a, Arc<Core>>;
type R<T = ()> = Result<T, String>;

// 所有 command 都是 async：跑在 tokio 线程上，不占主线程（见 engine.rs 的锁规则）。

#[tauri::command]
async fn get_state(core: St<'_>) -> R<Value> {
    Ok(core.state_now())
}

#[tauri::command]
async fn login(core: St<'_>) -> R {
    cloud::login(core.inner().clone()).await
}

#[tauri::command]
async fn logout(core: St<'_>) -> R {
    core.logout();
    Ok(())
}

/// 设置里的「检查更新」：有新版就下载好，返回给老师看的一句话
#[tauri::command]
async fn check_update(core: St<'_>) -> R<String> {
    update::check(core.inner()).await
}

/// 「重启更新」
#[tauri::command]
async fn install_update(core: St<'_>) -> R {
    update::install(core.inner())
}

/// 手动刷新课表
#[tauri::command]
async fn refresh_lessons(core: St<'_>) -> R {
    cloud::fetch_once(core.inner()).await
}

#[tauri::command]
async fn delete_lesson(core: St<'_>, lesson_id: String) -> R {
    core.delete_lesson(&lesson_id)?;
    let c = core.inner().clone();
    tauri::async_runtime::spawn(async move { cloud::discard_pending(&c).await });
    Ok(())
}

#[tauri::command]
async fn start_recording(core: St<'_>, lesson_id: String) -> R {
    core.start_recording(&lesson_id)
}

#[tauri::command]
async fn start_adhoc(core: St<'_>) -> R {
    core.start_adhoc()
}

#[tauri::command]
async fn name_adhoc(core: St<'_>, lesson_id: String, topic: String, kind: String) -> R {
    {
        let mut g = core.lock();
        core.set_name(&mut g, &lesson_id, &topic, &kind, engine::now_ms())?;
    }
    core.publish();
    Ok(())
}

#[tauri::command]
async fn set_fab(core: St<'_>, enabled: bool) -> R {
    core.set_fab(enabled);
    Ok(())
}

/// 悬浮按钮悬停展开 / 收起：保持右边缘不动
#[tauri::command]
async fn resize_fab(app: AppHandle, width: f64, height: f64) -> R {
    let w = app.get_webview_window("fab").ok_or("没有悬浮按钮窗口")?;
    let e = |e: tauri::Error| e.to_string();
    let (scale, old, pos) = (w.scale_factor().map_err(e)?, w.outer_size().map_err(e)?, w.outer_position().map_err(e)?);
    let new_w = (width * scale).round() as i32;
    w.set_size(LogicalSize::new(width, height)).map_err(e)?;
    w.set_position(PhysicalPosition::new(pos.x + old.width as i32 - new_w, pos.y)).map_err(e)
}

#[tauri::command]
async fn request_stop(core: St<'_>) -> R {
    core.with_active(|_, g, _| g.active.iter_mut().for_each(|a| a.confirm = true));
    Ok(())
}

#[tauri::command]
async fn resume_recording(core: St<'_>) -> R {
    core.with_active(|_, g, _| g.active.iter_mut().for_each(|a| a.confirm = false));
    Ok(())
}

#[tauri::command]
async fn end_recording(core: St<'_>) -> R {
    core.with_active(|c, g, now| c.stop_session(g, now));
    Ok(())
}

#[tauri::command]
async fn extend_recording(core: St<'_>) -> R {
    core.with_active(|c, g, _| c.extend(g));
    Ok(())
}

#[tauri::command]
async fn switch_mic(core: St<'_>, name: String) -> R {
    core.switch_mic(name);
    Ok(())
}

#[tauri::command]
async fn save_summary(core: St<'_>, lesson_id: String, text: String) -> R {
    cloud::save_summary(core.inner(), &lesson_id, &text).await
}

/// 先写剪贴板并在本地标记已复制（立即生效），再同步到云端；云端失败会返回错误，但剪贴板已经有内容。
#[tauri::command]
async fn copy_summary(app: AppHandle, core: St<'_>, lesson_id: String, text: String) -> R {
    app.clipboard().write_text(text.clone()).map_err(|e| e.to_string())?;
    {
        let mut g = core.lock();
        g.lessons.iter_mut().filter(|l| l.id == lesson_id).for_each(|l| {
            l.copied = true;
            l.summary = Some(text.clone());
        });
    }
    core.publish();
    cloud::save_summary(core.inner(), &lesson_id, &text).await?;
    cloud::mark_copied(core.inner(), &lesson_id).await
}

#[tauri::command]
async fn open_report(app: AppHandle, core: St<'_>, lesson_id: String) -> R {
    let url = core.lock().lessons.iter().find(|l| l.id == lesson_id).and_then(|l| l.report_url.clone()).ok_or("报告还没生成")?;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("报告链接无效".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_main(app: AppHandle, core: St<'_>, lesson_id: Option<String>) -> R {
    core.lock().selected = lesson_id;
    core.publish();
    show_main(&app);
    Ok(())
}

#[tauri::command]
async fn hide_toast(core: St<'_>) -> R {
    core.lock().toast = None;
    core.publish();
    Ok(())
}

#[tauri::command]
async fn set_autostart(app: AppHandle, core: St<'_>, enabled: bool) -> R {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    core.lock().autostart = al.is_enabled().unwrap_or(enabled);
    core.publish();
    Ok(())
}

/// 逻辑像素的整窗尺寸；保持窗口水平中心不动（用户拖过也不跳）。
#[tauri::command]
async fn resize_pill(app: AppHandle, width: f64, height: f64) -> R {
    let w = app.get_webview_window("pill").ok_or("没有胶囊窗口")?;
    let e = |e: tauri::Error| e.to_string();
    let (scale, old, pos) = (w.scale_factor().map_err(e)?, w.outer_size().map_err(e)?, w.outer_position().map_err(e)?);
    let new_w = (width * scale).round() as i32;
    w.set_size(LogicalSize::new(width, height)).map_err(e)?;
    w.set_position(PhysicalPosition::new(pos.x + old.width as i32 / 2 - new_w / 2, pos.y)).map_err(e)
}

#[tauri::command]
async fn start_level_preview(core: St<'_>) -> R {
    core.lock().preview_ui = true;
    core.refresh_mics();
    Ok(())
}

#[tauri::command]
async fn stop_level_preview(core: St<'_>) -> R {
    core.lock().preview_ui = false;
    core.publish();
    Ok(())
}

/// 打开主窗口（菜单栏 / 托盘、Dock、通知「查看」、重复启动）：顺带拉一次课表（10 分钟内拉过就不拉）、查一次更新（24 小时一次）
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Some(core) = app.try_state::<Arc<Core>>() {
        let last = core.last_fetch.load(std::sync::atomic::Ordering::Relaxed);
        if last != 0 && engine::now_ms() - last > 10 * engine::MIN {
            core.kick_fetch.notify_one();
        }
        update::on_open(core.inner());
    }
}

#[derive(Clone, Copy)]
enum Spot {
    TopCenter,
    TopRight,
    RightMiddle,
}

/// 胶囊：主屏工作区（菜单栏下方）顶部居中；通知：右上角；悬浮按钮：右侧中间。
fn place(w: &WebviewWindow, spot: Spot) -> tauri::Result<()> {
    let Some(m) = w.primary_monitor()? else { return Ok(()) };
    let (wa, scale, size) = (m.work_area(), m.scale_factor(), w.outer_size()?);
    let margin = (12.0 * scale) as i32;
    let right = wa.position.x + wa.size.width as i32 - size.width as i32;
    let (x, y) = match spot {
        Spot::TopCenter => (wa.position.x + (wa.size.width as i32 - size.width as i32) / 2, wa.position.y + margin),
        Spot::TopRight => (right - margin / 3, wa.position.y + margin / 3),
        Spot::RightMiddle => (right - margin / 2, wa.position.y + (wa.size.height as i32 - size.height as i32) / 2),
    };
    w.set_position(PhysicalPosition::new(x, y))
}

fn on_menu(app: AppHandle, id: String) {
    let core = app.state::<Arc<Core>>().inner().clone();
    match id.as_str() {
        "open" => show_main(&app),
        "stop" => core.with_active(|_, g, _| g.active.iter_mut().for_each(|a| a.confirm = true)),
        "adhoc" => {
            if let Err(e) = core.start_adhoc() {
                eprintln!("[menu] adhoc: {e}");
                show_main(&app); // 多半是没登录，打开主窗口让老师看到
            }
        }
        "settings" => {
            show_main(&app);
            let _ = app.emit("open-settings", ());
        }
        "quit" => {
            core.shutdown(); // 先把最后一段写盘、记 endedAt
            app.exit(0);
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .invoke_handler(tauri::generate_handler![
            get_state,
            login,
            logout,
            refresh_lessons,
            check_update,
            install_update,
            delete_lesson,
            start_recording,
            start_adhoc,
            name_adhoc,
            set_fab,
            resize_fab,
            request_stop,
            resume_recording,
            end_recording,
            extend_recording,
            switch_mic,
            save_summary,
            copy_summary,
            open_report,
            open_main,
            hide_toast,
            set_autostart,
            resize_pill,
            start_level_preview,
            stop_level_preview
        ])
        .setup(|app| {
            let core = Core::new(app.handle().clone())?;
            app.manage(core.clone());

            // 首次运行默认开机自启（开发构建不注册，免得把 debug 二进制加进登录项）
            let al = app.autolaunch();
            {
                let mut g = core.lock();
                if !g.cfg.autostart_init && !cfg!(debug_assertions) {
                    let _ = al.enable();
                    g.cfg.autostart_init = true;
                    core.save_cfg(&g.cfg);
                }
                g.autostart = al.is_enabled().unwrap_or(false);
            }

            for (label, spot) in [("pill", Spot::TopCenter), ("toast", Spot::TopRight), ("fab", Spot::RightMiddle)] {
                if let Some(w) = app.get_webview_window(label) {
                    place(&w, spot)?;
                }
            }

            #[cfg(target_os = "macos")]
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            #[cfg(not(target_os = "macos"))]
            let icon = app.default_window_icon().cloned().ok_or("missing app icon")?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("菁仕课堂")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, e| {
                    let (app, id) = (app.clone(), e.id().as_ref().to_string());
                    tauri::async_runtime::spawn(async move { on_menu(app, id) });
                })
                .build(app)?;

            let logged_in = core.lock().cfg.token.is_some();
            if !logged_in || !std::env::args().any(|a| a == "--autostart") {
                show_main(app.handle());
            }

            let c = core.clone();
            tauri::async_runtime::spawn(async move {
                let mut iv = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    iv.tick().await;
                    c.tick();
                }
            });
            tauri::async_runtime::spawn(cloud::fetch_loop(core.clone()));
            tauri::async_runtime::spawn(update::on_start(core.clone()));
            tauri::async_runtime::spawn(cloud::upload_loop(core));
            Ok(())
        })
        .on_window_event(|w, e| {
            // 关主窗口只是收进菜单栏 / 托盘
            if let (WindowEvent::CloseRequested { api, .. }, "main") = (e, w.label()) {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building 菁仕课堂")
        .run(|app, e| match e {
            RunEvent::ExitRequested { .. } => {
                if let Some(core) = app.try_state::<Arc<Core>>() {
                    core.shutdown();
                }
            }
            // 普通前台 App：点 Dock 图标重新打开主窗口
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
