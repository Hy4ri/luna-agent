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

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![notify])
        .setup(|_app| {
            #[cfg(desktop)]
            setup_tray(_app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running luna");
}
