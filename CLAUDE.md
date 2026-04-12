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

The bridge image is **multi-arch** (`linux/amd64` + `linux/arm64`) as of `bridge-v0.21.0`. The Dockerfile requires `TARGETARCH` to be set, so it must be built via `docker buildx` (plain `docker build` will fail with an explicit error).

```bash
# Local build for native platform (single-arch test)
docker buildx build --platform linux/amd64 -f Dockerfile.bridge -t xaiworkspace-bridge:latest --load .
```

### Publishing the bridge image to ECR

```bash
./scripts/push-bridge.sh              # Build + push multi-arch (amd64 + arm64), notify routers
```

The script:
1. Reads version from `bridge/package.json`
2. Verifies ECR Public credentials are present (fails fast with a login hint if missing)
3. Registers QEMU binfmt handlers if not already loaded (survives host reboots; volatile kernel state)
4. Auto-provisions an isolated buildx builder `xaiw-bridge-builder` (`docker-container` driver) on first run — does **not** mutate your default buildx builder
5. Builds `linux/amd64` + `linux/arm64` in one invocation, tags as both `bridge-vX.Y.Z` and `bridge-latest`, and pushes a single manifest list to `public.ecr.aws/s3b3q6t2/xaiworkspace-docker`
6. Optionally calls `POST /api/webhooks/ecr-push` on each router if `ECR_WEBHOOK_SECRET` is set (otherwise routers pick up the new version on their 30-min ECR poll)

**Prerequisites** (first run only, auto-handled):
- `docker buildx` (ships with Docker 20.10+)
- QEMU binfmt handlers (`tonistiigi/binfmt` — installed by the script under `--privileged`)
- ECR Public login: `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws` (tokens last ~12h — refresh before each release)

**Dockerfile notes**:
- `COMPOSE_VERSION` ARG pins the docker-compose v2 plugin version; the binary is downloaded per `TARGETARCH` during build and verified against the upstream `.sha256`
- `--skip-build` was removed in the multi-arch rewrite (build + push are a single buildx step — you can't `docker load` a multi-arch manifest list)

## Architecture

| Component | Role | Code |
|-----------|------|------|
| `config.rs` | Load config: local file > router API > defaults | `DesktopConfig` struct |
| `docker.rs` | Detect/install Docker Desktop per platform | `is_available()`, `install()` |
| `bridge.rs` | Pull image, create/start container, health check, mount secrets | `run()`, `wait_for_health()` |
| `oauth.rs` | TCP listeners on OAuth callback ports, state validation, forward to router | `OAuthManager` with toggle + `pending_states` |
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
workspace-base/
  bridge.js        # Bootstrap bridge for bare workspace containers (install/exec/uninstall)
  entrypoint.sh    # Container entrypoint: writes secrets.env, starts workspace agent
bridge/
  compose-manager.js  # Docker Compose management for workspace containers
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
- **OAuth state validation**: Callbacks require a state parameter (min 8 chars, alphanumeric + `-_~.`). States registered by this app are consumed on first use; externally-initiated states are format-validated as defense-in-depth (router does authoritative check)
- **Port conflict**: Bridge container maps OAuth ports; Tauri listeners silently skip bound ports (EADDRINUSE)
- **Admin elevation**: macOS `osascript`, Windows `PowerShell RunAs`, Linux `pkexec`/`sudo`
- **FUSE bypass**: AppImage uses `--appimage-extract-and-run` on GNOME 46+ (no executable double-click)

## Security

- **Secret mounting**: `ROUTER_SECRET` is written to a temp file (0600 perms) and bind-mounted into the container at `/run/secrets/router_secret` instead of passed as `-e` env var. This prevents exposure via `docker inspect`. The bridge `server.js` reads from the secret file with env var fallback.
- **GW_PASSWORD injection-safe**: `workspace-base/entrypoint.sh` passes `GW_PASSWORD` to the Node.js config-patch script via `process.env.GW_PASSWORD` (not shell string interpolation), preventing injection via a password containing shell metacharacters.
- **503 on missing ROUTER_SECRET**: `bridge/server.js` returns HTTP 503 (not 500) when `ROUTER_SECRET` is empty/unset, making misconfiguration distinguishable from runtime errors. All secret comparisons in `server.js` use `safeCompare()` (timing-safe, based on `crypto.timingSafeEqual`).
- **Exec allowlists**: Both `bridge/bridge.js` and `workspace-base/bridge.js` restrict commands to allowlisted prefixes (e.g. `docker`, `node`, `pm2`, `bash scripts/`). Shell metacharacters (`;`, backticks) are blocked to prevent injection.
- **Input validation**: User fields must be alphanumeric/dash/underscore. Working directories must be absolute paths without `..`. Commands have a 10KB length limit and 5-minute timeout.
- **Trusted URL domains**: `workspace-base/bridge.js` only downloads artifacts/source from an allowlist of domains (github.com, registry.npmjs.org, xaiworkspace.com, etc.). Non-HTTPS and unknown domains are rejected.

## Setup Flow (lib.rs → run_setup)

```
1. Load config (local file > router > defaults)
2. Fetch versioned bridge image tag from GET /api/config/desktop
3. Set up tray with OAuth toggles
4. Check Docker → install if missing (platform-specific, elevated)
5. Check bridge container → pull versioned image + create if missing (with PAIRING_CODE)
6. Wait for health (localhost:3100/health)
7. Open browser (bridge redirects to /link?code=XXXX for pairing)
8. Hide window → tray
9. Start OAuth listeners (all on, skip ports bound by bridge)
```

## Bridge Container

Image: `public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-v<version>` (versioned tag — not `:latest`). The current version is fetched from `GET /api/config/desktop` at Tauri startup and used in all `docker run` commands.

Runs two pm2 processes:
- `pairing-server` (server.js) — health endpoint + pairing code redirect on port 3100. Registers bridge with router, writes auth credentials to `/data/auth.json`.
- `bridge` (bridge.js) — WebSocket bridge between router and local gateway. Reads auth from `AUTH_JSON` env var first, then falls back to `/data/auth.json`. Re-reads credentials on each reconnect attempt so it picks up tokens written by the pairing server. Waits gracefully if no credentials are available yet.

Ports mapped: 3100 (pairing), 54545 (Claude OAuth), 8085 (Gemini), 1455 (Codex)

Secret: `ROUTER_SECRET` mounted as `/run/secrets/router_secret` (read-only bind mount from host temp file). `server.js` reads secret file first, falls back to env var.

**Auto-discovery flow**: When started with `PAIRING_CODE` env var, the bridge calls `POST /api/bridges/claim-device` to exchange the code (5-min TTL) for a unique `bridgeId` + `bridgeToken`. After connecting to the router WS, the router sends `scan_bridges`; the bridge scans Docker for sibling bridge containers and reports back. Router responds with `bridge_adopt` (join existing stack) or `bridge_primary` (recreate with mapped ports).

**OS detection**: Bridge queries Docker API `/info` at startup to detect host OS — `linuxkit` kernel → macOS, `WSL` in OS name → Windows, otherwise Linux. Reported to router on self-registration.

**Instance WS commands**: Bridge handles `start_instance`, `stop_instance`, `remove_instance`, and `stop_orphan` commands sent from the router via WS (bridge v0.19.0+). No direct Docker CLI calls from the frontend.

**Provisioning progress**: Bridge emits `instance_provision_progress` events (`pulling` → `starting` → `ready`) during workspace container creation, and `bridge_provision_progress` events during bridge container setup. Both are forwarded to the frontend via router WS.

**Auto-updater**: Checks ECR for a newer bridge image every 30 minutes. Forwards update progress as `bridge_update_progress` WS events. Skipped on ephemeral `PAIRING_CODE` containers.

**E2E tests**: `bridge-domain-connection.spec.ts` (20 tests, desktop + mobile) — validates bridge connects to real domain (not localhost), authenticates, appears as connected in Settings page.

## App Icon (X-Dot)

The application icon is "X-Dot" — an X shape with a single dot above it. **Not** three dots.

Icon files in `src-tauri/icons/`:
- `tray-icon.png`, `tray-icon-dark.png`, `tray-icon-light.png` — system tray icons (theme-aware)
- `32x32.png`, `128x128.png`, `128x128@2x.png` — app window icons
- `icon.icns` (macOS), `icon.ico` (Windows), `icon.png` — bundle icons

Config: `tauri.conf.json` → `app.trayIcon.iconPath` and `bundle.icon[]`.

**Testing**: Icon integrity is verified by `xdot-icon.spec.ts` in the frontend E2E suite (`pnpm e2e:xdot` from xaiworkspace-frontend). Tests check all Tauri icon files exist, are non-empty, and match `tauri.conf.json` references.

## Code Signing

macOS: Developer ID Application certificate from Apple (xShopper Pty Ltd, Team ID D3BS8AH5D9). Stored as GitHub Actions secrets. CI signs + notarizes via `tauri-apps/tauri-action`.

## CI/CD

`.github/workflows/build.yml` — triggers on `v*` tags. Builds Linux (.AppImage), macOS (.dmg, signed+notarized), Windows (.msi). Uses `tauri-apps/tauri-action` with Rust cache.

## Workspace Container Startup

`workspace-base/entrypoint.sh` runs on workspace container start:
1. Writes secrets to `/etc/xai/secrets.env` from container env vars
2. Creates `~/apps` directory for mini-app installs
3. Starts pm2-runtime with the workspace agent

OpenClaw is installed as a mini-app via the workspace agent after the container starts — it is not baked into the image. The OpenClaw mini-app's own `install.sh` handles gateway configuration.

## Related Projects

- `xaiworkspace-frontend` — Angular 21 SPA (has `/link` route for device pairing)
- `xaiworkspace-backend` — Router API (`/api/instances/claim`, `/api/config/desktop`)
- `xaiworkspace-docker` — Docker Compose for local dev (router, frontend, postgres)
