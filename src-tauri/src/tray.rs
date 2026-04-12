use std::process::Command;
use tauri::{
    AppHandle,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

/// Detect if the system is using a dark theme.
fn is_dark_theme() -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "color-scheme"])
            .output()
        {
            if String::from_utf8_lossy(&output.stdout).contains("dark") { return true; }
        }
        if let Ok(output) = Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
            .output()
        {
            if String::from_utf8_lossy(&output.stdout).to_lowercase().contains("dark") { return true; }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
        {
            if output.status.success() { return true; }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "AppsUseLightTheme"])
            .output()
        {
            if String::from_utf8_lossy(&output.stdout).contains("0x0") { return true; }
        }
    }
    false
}

/// Check bridge container health via Docker CLI.
fn get_bridge_status() -> &'static str {
    let output = Command::new("docker")
        .args(["ps", "--filter", "name=xaiw-bridge", "--filter", "health=healthy", "--format", "{{.Names}}"])
        .output();

    match output {
        Ok(o) if o.status.success() && !o.stdout.is_empty() => "● Bridge: Healthy",
        _ => {
            // Check if any bridge container exists at all
            let exists = Command::new("docker")
                .args(["ps", "-a", "--filter", "name=xaiw-bridge", "--format", "{{.Names}}"])
                .output()
                .map(|o| o.status.success() && !o.stdout.is_empty())
                .unwrap_or(false);
            if exists { "○ Bridge: Unhealthy" } else { "○ Bridge: Not Running" }
        }
    }
}

/// Set up the system tray icon and menu.
/// Minimal: Open website, bridge status, quit. No network activity.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open_item = MenuItem::with_id(app, "open", "Open xAI Workspace", true, None::<&str>)?;
    let bridge_item = MenuItem::with_id(app, "bridge_status", get_bridge_status(), false, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[
        &open_item,
        &bridge_item,
        &sep,
        &quit_item,
    ])?;

    // Theme-aware icon
    let icon_bytes: &[u8] = if is_dark_theme() {
        include_bytes!("../icons/tray-icon-dark.png")
    } else {
        include_bytes!("../icons/tray-icon-light.png")
    };
    let icon = tauri::image::Image::from_bytes(icon_bytes)
        .map_err(|e| -> Box<dyn std::error::Error> {
            format!("Failed to load tray icon: {e}").into()
        })?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("xAI Workspace")
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                "open" => {
                    // Open the web app — uses the default browser, no network from Tauri
                    let _ = open::that("https://xaiworkspace.com");
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    // Periodically update bridge status via Docker CLI (local only, no network)
    let status_item = bridge_item.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let _ = status_item.set_text(get_bridge_status());
        }
    });

    Ok(())
}
