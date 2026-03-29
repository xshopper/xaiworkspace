use std::process::Command;
use tauri::{AppHandle, Emitter};

/// Check if Docker is installed and the daemon is responsive.
pub fn is_available() -> bool {
    Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Install Docker Desktop. Platform-specific.
///
/// Emits `setup-progress` events so the frontend can show status.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Installing Docker Desktop...",
        "percent": 20
    }));

    #[cfg(target_os = "macos")]
    {
        install_macos().await?;
    }
    #[cfg(target_os = "windows")]
    {
        install_windows().await?;
    }
    #[cfg(target_os = "linux")]
    {
        install_linux().await?;
    }

    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Waiting for Docker to start...",
        "percent": 40
    }));

    wait_for_daemon(120).await
}

/// Wait for Docker daemon to become responsive.
pub async fn wait_for_daemon(timeout_secs: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        if is_available() {
            return Ok(());
        }
        if start.elapsed().as_secs() > timeout_secs {
            return Err("Docker daemon did not start within timeout".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

#[cfg(target_os = "macos")]
async fn install_macos() -> Result<(), String> {
    // Determine architecture for correct download
    let arch = std::env::consts::ARCH;
    let url = if arch == "aarch64" {
        "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
    } else {
        "https://desktop.docker.com/mac/main/amd64/Docker.dmg"
    };

    let tmp = "/tmp/Docker.dmg";

    // Download
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(tmp, &bytes).await.map_err(|e| e.to_string())?;

    // Mount DMG, copy to /Applications (requires admin), and launch.
    // Uses osascript to trigger macOS admin prompt for the copy.
    Command::new("hdiutil")
        .args(["attach", tmp, "-quiet"])
        .status()
        .map_err(|e| e.to_string())?;

    Command::new("osascript")
        .args([
            "-e",
            r#"do shell script "cp -R /Volumes/Docker/Docker.app /Applications/Docker.app" with administrator privileges"#,
        ])
        .status()
        .map_err(|e| format!("Admin authorization required to install Docker: {e}"))?;

    Command::new("hdiutil")
        .args(["detach", "/Volumes/Docker", "-quiet"])
        .status()
        .ok();

    // Launch Docker Desktop
    Command::new("open")
        .args(["/Applications/Docker.app"])
        .status()
        .map_err(|e| e.to_string())?;

    // Clean up
    tokio::fs::remove_file(tmp).await.ok();

    Ok(())
}

#[cfg(target_os = "windows")]
async fn install_windows() -> Result<(), String> {
    // Check WSL2 availability
    let wsl_check = Command::new("wsl")
        .args(["--status"])
        .output();

    if wsl_check.is_err() || !wsl_check.unwrap().status.success() {
        // Install WSL2 — this may require a reboot
        Command::new("wsl")
            .args(["--install", "--no-distribution"])
            .status()
            .map_err(|e| format!("Failed to install WSL2: {e}"))?;
    }

    let url = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
    let tmp = std::env::temp_dir().join("DockerDesktopInstaller.exe");

    // Download
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;

    // Run installer with UAC elevation (triggers Windows admin prompt)
    Command::new("powershell")
        .args([
            "-Command",
            &format!("Start-Process '{}' -ArgumentList 'install','--quiet','--accept-license' -Verb RunAs -Wait",
                tmp.display()),
        ])
        .status()
        .map_err(|e| format!("Docker installer failed: {e}"))?;

    // Clean up
    tokio::fs::remove_file(&tmp).await.ok();

    // Start Docker Desktop
    let docker_path = format!(
        "{}\\Docker\\Docker\\Docker Desktop.exe",
        std::env::var("ProgramFiles").unwrap_or_default()
    );
    Command::new(&docker_path).spawn().ok();

    Ok(())
}

#[cfg(target_os = "linux")]
async fn install_linux() -> Result<(), String> {
    // Use pkexec for graphical sudo prompt (works in desktop environments)
    // Falls back to sudo if pkexec is not available
    let has_pkexec = Command::new("which").arg("pkexec").output()
        .map(|o| o.status.success()).unwrap_or(false);

    let (cmd, args) = if has_pkexec {
        ("pkexec", vec!["sh", "-c", "curl -fsSL https://get.docker.com | sh"])
    } else {
        ("sudo", vec!["sh", "-c", "curl -fsSL https://get.docker.com | sh"])
    };

    let status = Command::new(cmd)
        .args(&args)
        .status()
        .map_err(|e| format!("Docker install failed: {e}"))?;

    if !status.success() {
        return Err("Docker install script failed".into());
    }

    // Add current user to docker group
    if let Ok(user) = std::env::var("USER") {
        let elevate = if has_pkexec { "pkexec" } else { "sudo" };
        Command::new(elevate)
            .args(["usermod", "-aG", "docker", &user])
            .status()
            .ok();
    }

    Ok(())
}
