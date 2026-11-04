use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// Keep the tray menu item in step with the window: "Hide Luna" while visible, "Show Luna" otherwise.
#[cfg(desktop)]
fn sync_tray_label(app: &AppHandle, visible: bool) {
    if let Some(item) = app.try_state::<MenuItem<tauri::Wry>>() {
        let _ = item.set_text(if visible { "Hide Luna" } else { "Show Luna" });
    }
}

#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        sync_tray_label(app, true);
    }
}

#[cfg(desktop)]
fn toggle_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) => {
            let _ = w.hide();
            sync_tray_label(app, false);
        }
        _ => show_main(app),
    }
}

/// System notification. Called from the web UI when a session changes state.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    // Android 13+ needs the POST_NOTIFICATIONS permission at run time. A no-op once granted.
    #[cfg(mobile)]
    if !matches!(
        app.notification().permission_state(),
        Ok(tauri_plugin_notification::PermissionState::Granted)
    ) && !matches!(
        app.notification().request_permission(),
        Ok(tauri_plugin_notification::PermissionState::Granted)
    ) {
        return;
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Native Android download plugin (gen/android/.../DownloadPlugin.kt).
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct Push(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
fn push_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("luna-push")
        .setup(|app, api| {
            app.manage(Push(api.register_android_plugin("dev.luna.mobile", "PushPlugin")?));
            Ok(())
        })
        .build()
}

/// FCM registration token of this phone (PushPlugin.kt). Android only.
#[tauri::command]
async fn get_push_token(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<Push>().0.run_mobile_plugin("getToken", ()).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("push is only available on Android".into())
    }
}

#[cfg(target_os = "android")]
struct Downloads(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
fn downloads_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("luna-downloads")
        .setup(|app, api| {
            app.manage(Downloads(
                api.register_android_plugin("dev.luna.mobile", "DownloadPlugin")?,
            ));
            Ok(())
        })
        .build()
}

/// Save a file to the shared Downloads folder. `data` is base64. Android only: its WebView ignores `<a download>`.
/// Async so the blocking plugin call stays off the main thread.
#[tauri::command]
async fn save_download(
    app: AppHandle,
    name: String,
    mime: String,
    data: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args {
            name: String,
            mime: String,
            data: String,
        }
        #[derive(serde::Deserialize)]
        struct Saved {
            name: String,
        }
        let saved: Saved = app
            .state::<Downloads>()
            .0
            .run_mobile_plugin("save", Args { name, mime, data })
            .map_err(|e| e.to_string())?;
        Ok(saved.name)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, name, mime, data);
        Err("save_download is only available on Android".into())
    }
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "toggle", "Hide Luna", true, None::<&str>)?;
    app.manage(show.clone());
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Luna")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // A second launch focuses the running instance instead of opening another window.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        show_main(app)
    }));

    // Closing the window keeps the app running in the tray so notifications keep arriving.
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
            sync_tray_label(window.app_handle(), false);
        }
    });

    #[cfg(target_os = "android")]
    let builder = builder.plugin(downloads_plugin()).plugin(push_plugin());

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![notify, save_download, get_push_token])
        .setup(|_app| {
            #[cfg(desktop)]
            setup_tray(_app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running luna");
}
