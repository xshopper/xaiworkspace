use std::sync::Arc;
use tauri::{
    AppHandle,
    menu::{Menu, MenuItem, PredefinedMenuItem, CheckMenuItem},
    tray::TrayIconBuilder,
};
use crate::oauth::OAuthManager;
use crate::config::DesktopConfig;

/// Set up the system tray icon and menu with OAuth port toggles.
pub fn setup(app: &AppHandle, cfg: &DesktopConfig, oauth: Arc<OAuthManager>) -> Result<(), Box<dyn std::error::Error>> {
    let open_item = MenuItem::with_id(app, "open", "Open xAI Workspace", true, None::<&str>)?;
    let status_item = MenuItem::with_id(app, "status", "Bridge: checking...", false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    // OAuth port toggle items — one per provider, default checked (on)
    let mut oauth_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for provider in &cfg.oauth_providers {
        let label = format!("{} (port {})", capitalize(&provider.name), provider.port);
        let item = CheckMenuItem::with_id(
            app,
            format!("oauth_{}", provider.name),
            &label,
            true,  // enabled
            true,  // default checked = on
            None::<&str>,
        )?;
        oauth_items.push(item);
    }

    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    // Build menu
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &open_item,
        &status_item,
        &sep1,
    ];
    for item in &oauth_items {
        items.push(item);
    }
    items.push(&sep2);
    items.push(&quit_item);

    let menu = Menu::with_items(app, &items)?;

    // Keep references to check items for toggling
    let check_items: Vec<(String, CheckMenuItem<tauri::Wry>)> = oauth_items
        .into_iter()
        .enumerate()
        .map(|(i, item)| (cfg.oauth_providers[i].name.clone(), item))
        .collect();
    let check_items = Arc::new(check_items);

    let oauth_mgr = oauth.clone();
    let items_ref = check_items.clone();

    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("xAI Workspace")
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            match id.as_str() {
                "open" => {
                    let _ = open::that("https://app.xaiworkspace.com");
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
                        // Update check mark
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

    Ok(())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}
