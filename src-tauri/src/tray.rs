use std::sync::Arc;
use std::process::Command;
use tauri::{
    AppHandle,
    menu::{Menu, MenuItem, PredefinedMenuItem, CheckMenuItem},
    tray::TrayIconBuilder,
};
use crate::oauth::OAuthManager;
use crate::config::DesktopConfig;

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
pub fn setup(app: &AppHandle, cfg: &DesktopConfig, oauth: Arc<OAuthManager>) -> Result<(), Box<dyn std::error::Error>> {
    let open_item = MenuItem::with_id(app, "open", "Open xAI Workspace", true, None::<&str>)?;
    let bridge_item = MenuItem::with_id(app, "bridge_status", get_bridge_status(), false, None::<&str>)?;
    let restart_item = MenuItem::with_id(app, "restart_bridge", "Restart Bridge (pull latest)", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    let mut oauth_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for provider in &cfg.oauth_providers {
        let label = format!("{} (port {})", capitalize(&provider.name), provider.port);
        let item = CheckMenuItem::with_id(
            app, format!("oauth_{}", provider.name), &label,
            true, true, None::<&str>,
        )?;
        oauth_items.push(item);
    }

    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &open_item,
        &bridge_item,
        &restart_item,
        &sep1,
    ];
    for item in &oauth_items {
        items.push(item);
    }
    items.push(&sep2);
    items.push(&quit_item);

    let menu = Menu::with_items(app, &items)?;

    let check_items: Vec<(String, CheckMenuItem<tauri::Wry>)> = oauth_items
        .into_iter()
        .enumerate()
        .map(|(i, item)| (cfg.oauth_providers[i].name.clone(), item))
        .collect();
    let check_items = Arc::new(check_items);

    let app_url = cfg.app_url.clone();
    let bridge_image = cfg.bridge_image.clone();
    let oauth_mgr = oauth.clone();
    let items_ref = check_items.clone();
    let bridge_status_item = bridge_item;
    let bridge_status_for_poll = bridge_status_item.clone();

    // Theme-aware icon
    let icon_bytes: &[u8] = if is_dark_theme() {
        include_bytes!("../icons/tray-icon-dark.png")
    } else {
        include_bytes!("../icons/tray-icon-light.png")
    };
    let icon = tauri::image::Image::from_bytes(icon_bytes)
        .expect("Failed to load tray icon");

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("xAI Workspace")
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            match id.as_str() {
                "open" => {
                    let _ = open::that(&app_url);
                }
                "restart_bridge" => {
                    let img = bridge_image.clone();
                    let status = bridge_status_item.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = status.set_text("○ Bridge: Restarting...");

                        // Stop and remove all bridge containers
                        let _ = Command::new("sh")
                            .args(["-c", "docker rm -f $(docker ps -aq --filter name=xaiw-bridge) 2>/dev/null"])
                            .status();

                        // Pull latest image
                        let _ = status.set_text("○ Bridge: Pulling image...");
                        let _ = Command::new("docker")
                            .args(["pull", &img])
                            .status();

                        // Start fresh bridge
                        let _ = status.set_text("○ Bridge: Starting...");
                        let _ = Command::new("docker")
                            .args([
                                "run", "-d", "--name", "xaiw-bridge",
                                "--restart", "unless-stopped",
                                "--add-host=host.docker.internal:host-gateway",
                                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                                "-p", "3100:3100",
                                "-e", "INSTANCE_ID=xaiw-bridge",
                                "-e", &format!("ROUTER_URL=http://host.docker.internal:8080"),
                                &img,
                            ])
                            .status();

                        // Wait for healthy
                        for _ in 0..15 {
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            if get_bridge_status().contains("Healthy") {
                                let _ = status.set_text("● Bridge: Healthy");
                                return;
                            }
                        }
                        let _ = status.set_text(get_bridge_status());
                    });
                }
                "quit" => {
                    app.exit(0);
                }
                _ if id.starts_with("oauth_") => {
                    let provider = id.strip_prefix("oauth_").unwrap().to_string();
                    let mgr = oauth_mgr.clone();
                    let items = items_ref.clone();
                    tauri::async_runtime::spawn(async move {
                        let is_on = mgr.toggle(&provider).await;
                        for (name, item) in items.iter() {
                            if name == &provider {
                                let _ = item.set_checked(is_on);
                                break;
                            }
                        }
                    });
                }
                _ => {}
            }
        })
        .build(app)?;

    // Periodically update bridge status (every 30s)
    let status_item = bridge_status_for_poll;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let _ = status_item.set_text(get_bridge_status());
        }
    });

    Ok(())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}
