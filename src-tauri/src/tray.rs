use tauri::{
    AppHandle,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

/// Set up the system tray icon and menu.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open_item = MenuItem::with_id(app, "open", "Open xAI Workspace", true, None::<&str>)?;
    let status_item = MenuItem::with_id(app, "status", "Bridge: checking...", false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_item, &status_item, &quit_item])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("xAI Workspace")
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                "open" => {
                    let _ = open::that("https://app.xaiworkspace.com");
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

/// Update the bridge status text in the tray menu.
pub fn update_status(app: &AppHandle, running: bool) {
    // Tray menu items can't be easily updated after creation in Tauri 2.
    // For now, the status is set at build time. A more dynamic approach would
    // rebuild the menu on status change. This is a future enhancement.
    let _ = (app, running);
}
