# CLAUDE.md — xAI Workspace Desktop (Tauri)

## Project Overview

Lightweight Tauri 2 desktop app (Rust + HTML) that sits in the system tray. Three jobs: install Docker, run the bridge container, and intercept OAuth callbacks. Not smart — the router is the brain.

## Key Commands

```bash
pnpm install                  # Install Tauri CLI
pnpm tauri dev                # Dev mode (hot reload)
pnpm tauri build              # Production build → src-tauri/target/release/bundle/
```

### Linux build dependencies

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev libsoup-3.0-dev patchelf
```

### Bridge Docker image

```bash
docker build -f Dockerfile.bridge -t xaiworkspace-bridge:latest .
```

## Architecture

| Component | Role | Code |
|-----------|------|------|
| `config.rs` | Load config: local file > router API > defaults | `DesktopConfig` struct |
| `docker.rs` | Detect/install Docker Desktop per platform | `is_available()`, `install()` |
| `bridge.rs` | Pull image, create/start container, health check | `run()`, `wait_for_health()` |
| `oauth.rs` | TCP listeners on OAuth callback ports, forward to router | `OAuthManager` with toggle |
| `tray.rs` | System tray with OAuth port toggles | `CheckMenuItem` per provider |
| `lib.rs` | Setup flow orchestration, single instance guard | `run_setup()` |

## File Structure

```
src-tauri/src/
  main.rs          # Entry point → lib::run()
  lib.rs           # Setup flow, single instance, Tauri builder
  config.rs        # Config loading (local file / router API / defaults)
  docker.rs        # Docker detection + platform-specific install
  bridge.rs        # Container lifecycle (pull, run, health, open browser)
  oauth.rs         # OAuthManager + TCP listeners with CancellationToken
  tray.rs          # System tray menu with per-provider toggles
src/
  index.html       # Progress bar UI (dark theme)
bridge/
  server.js        # Pairing server (health + redirect) — runs inside Docker
  bridge.js        # WS bridge (router ↔ gateway) — runs inside Docker
  ecosystem.config.js  # pm2 config for both processes
config/
  dev.json         # Local dev config (localhost)
  test.json        # Test environment config
```

## Config System

Priority: local file > router API > defaults.

**Local file**: `xaiworkspace-config.json` next to the executable. Use `config/dev.json` or `config/test.json`.

**Router API**: `GET /api/config/desktop` returns `DesktopConfig` JSON.

**Fields**: `bridgeImage`, `bridgePorts`, `oauthProviders[{name,port}]`, `routerUrl`, `appUrl`.

## Key Patterns

- **Single instance**: `tauri-plugin-single-instance` — second launch focuses existing window
- **OAuth toggle**: `OAuthManager` uses `CancellationToken` per listener; tray `CheckMenuItem` toggles on/off
- **Port conflict**: Bridge container maps OAuth ports; Tauri listeners silently skip bound ports (EADDRINUSE)
- **Admin elevation**: macOS `osascript`, Windows `PowerShell RunAs`, Linux `pkexec`/`sudo`
- **FUSE bypass**: AppImage uses `--appimage-extract-and-run` on GNOME 46+ (no executable double-click)

## Setup Flow (lib.rs → run_setup)

```
1. Load config (local file > router > defaults)
2. Set up tray with OAuth toggles
3. Check Docker → install if missing (platform-specific, elevated)
4. Check bridge container → pull image + create if missing
5. Wait for health (localhost:3100/health)
6. Open browser (bridge redirects to /link?code=XXXX for pairing)
7. Hide window → tray
8. Start OAuth listeners (all on, skip ports bound by bridge)
```

## Bridge Container

Image: `public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-latest`

Runs two pm2 processes:
- `pairing-server` (server.js) — health endpoint + pairing code redirect on port 3100
- `bridge` (bridge.js) — WebSocket bridge between router and local gateway

Ports mapped: 3100 (pairing), 54545 (Claude OAuth), 8085 (Gemini), 1455 (Codex)

## Code Signing

macOS: Developer ID Application certificate from Apple (xShopper Pty Ltd, Team ID D3BS8AH5D9). Stored as GitHub Actions secrets. CI signs + notarizes via `tauri-apps/tauri-action`.

## CI/CD

`.github/workflows/build.yml` — triggers on `v*` tags. Builds Linux (.AppImage), macOS (.dmg, signed+notarized), Windows (.msi). Uses `tauri-apps/tauri-action` with Rust cache.

## Related Projects

- `xaiworkspace-frontend` — Angular 21 SPA (has `/link` route for device pairing)
- `xaiworkspace-backend` — Router API (`/api/instances/claim`, `/api/config/desktop`)
- `xaiworkspace-docker` — Docker Compose for local dev (router, frontend, postgres)
