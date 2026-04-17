# CLAUDE.md — xAI Workspace Desktop (Tauri)

## Project Overview

Lightweight Tauri 2 desktop app (Rust + HTML) that sits in the system tray. Two jobs: install Docker and run the bridge container via deep link. Not smart — the router is the brain. OAuth is handled by the workspace CLIProxyAPI (not the Tauri app).

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
| `bridge.rs` | Pull image, create/start container, health check, mount secrets | `create_new_bridge()`, `provision_bridge()`, `claim_bridge()`, `get_bridge_info()` |
| `tray.rs` | System tray menu (quit) | Minimal tray |
| `lib.rs` | Setup flow orchestration, deep link provisioning, single instance guard | `run_setup()`, `handle_provision()` |

## File Structure

```
src-tauri/src/
  main.rs          # Entry point → lib::run()
  lib.rs           # Setup flow, deep link provisioning, single instance, Tauri builder
  config.rs        # Config loading (local file / router API / defaults)
  docker.rs        # Docker detection + platform-specific install
  bridge.rs        # Container lifecycle (pull, run, health, open browser)
  tray.rs          # System tray menu
src/
  index.html       # Progress bar UI (dark theme)
bridge/
  server.js        # Pairing server (health + redirect) — runs inside Docker
  bridge.js        # WS bridge (router ↔ gateway) — runs inside Docker
  ecosystem.config.js  # pm2 config for both processes
  compose-manager.js  # Docker Compose management for workspace containers
  updater.js       # Auto-updater: polls ECR for new bridge image every 30 minutes
workspace-base/
  bridge.js        # Bootstrap bridge for bare workspace containers (install/exec/uninstall)
  entrypoint.sh    # Container entrypoint: writes secrets.env, starts workspace agent
config/
  dev.json         # Local dev config (localhost)
  test.json        # Test environment config
```

## Config System

Priority: local file > deep link params > defaults. (Router API config fetch removed — provisioning is now deep-link driven.)

**Local file**: `xaiworkspace-config.json` next to the executable. Use `config/dev.json` or `config/test.json`.

**Deep link params**: `xaiworkspace://provision?router=URL&app=URL&token=JWT&image=TAG` — overrides routerUrls, appUrl, and bridgeImage from the deep link.

**Fields** (`DesktopConfig`): `bridgeImage`, `bridgePorts`, `routerUrls` (array — multi-router support), `appUrl`, `composeDir` (optional — Docker Compose mode).

## Key Patterns

- **Single instance**: `tauri-plugin-single-instance` — second launch focuses existing window
- **Deep link provisioning**: `xaiworkspace://provision?router=URL&app=URL&token=JWT` triggers bridge container creation from the web app's "Add System" flow. 5-second dedup window prevents duplicate OS handler invocations on Linux
- **Admin elevation**: macOS `osascript`, Windows `PowerShell RunAs`, Linux `pkexec`/`sudo`
- **FUSE bypass**: AppImage uses `--appimage-extract-and-run` on GNOME 46+ (no executable double-click)

## Security

- **Bridge authentication**: Bridges provisioned via deep link use a per-bridge `BRIDGE_TOKEN` (from `POST /api/bridges`), not `ROUTER_SECRET`. The token is passed as `-e BRIDGE_TOKEN=...` env var. Legacy bridges using `ROUTER_SECRET` still work (server.js reads from `/run/secrets/router_secret` bind mount or env var fallback).
- **GW_PASSWORD injection-safe**: `workspace-base/entrypoint.sh` passes `GW_PASSWORD` to the Node.js config-patch script via `process.env.GW_PASSWORD` (not shell string interpolation), preventing injection via a password containing shell metacharacters.
- **503 on missing ROUTER_SECRET**: `bridge/server.js` returns HTTP 503 (not 500) when `ROUTER_SECRET` is empty/unset, making misconfiguration distinguishable from runtime errors. All secret comparisons in `server.js` use `safeCompare()` (timing-safe, based on `crypto.timingSafeEqual`).
- **Exec allowlists**: Both `bridge/bridge.js` and `workspace-base/bridge.js` restrict commands to allowlisted prefixes (e.g. `docker`, `node`, `pm2`, `bash scripts/`). Shell metacharacters (`;`, backticks) are blocked to prevent injection.
- **Input validation**: User fields must be alphanumeric/dash/underscore. Working directories must be absolute paths without `..`. Commands have a 10KB length limit and 5-minute timeout.
- **Trusted URL domains**: `workspace-base/bridge.js` only downloads artifacts/source from an allowlist of domains (github.com, registry.npmjs.org, xaiworkspace.com, etc.). Non-HTTPS and unknown domains are rejected.

## Setup Flow (lib.rs → run_setup)

```
1. Check Docker → report if missing
2. Set up system tray
3. Hide window → tray
4. Wait for deep link (xaiworkspace://provision?router=URL&app=URL&token=JWT)
```

**Deep link provisioning** (lib.rs → handle_provision):
```
1. Dedup check (5s cooldown for duplicate OS handler invocations)
2. Build config from deep link params (router URL, app URL, optional image)
3. Check Docker → error if not available (user must install)
4. If bridge already running → check membership via router API → claim or reuse
5. docker pull image + POST /api/bridges (gets bridgeId + bridgeToken)
6. Claim bridge via API (auto-link to user before container starts)
7. docker run bridge container with BRIDGE_ID + BRIDGE_TOKEN + ROUTER_URLS
8. Open browser to pairing URL (or silent if claimed directly)
```

## Bridge Container

Image: `public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-latest` (default from `DesktopConfig`). Can be overridden via deep link `image` param or local config file. Tauri no longer fetches config from `GET /api/config/desktop` — bridge provisioning is driven entirely by deep link parameters.

Runs two pm2 processes:
- `pairing-server` (server.js) — health endpoint + pairing code redirect on port 3100. Registers bridge with router, writes auth credentials to `/data/auth.json`.
- `bridge` (bridge.js) — WebSocket bridge between router and local gateway. Reads auth from `AUTH_JSON` env var first, then falls back to `/data/auth.json`. Re-reads credentials on each reconnect attempt so it picks up tokens written by the pairing server. Waits gracefully if no credentials are available yet.

Ports mapped: 3100 (pairing/health only). OAuth callback ports (54545, 8085, 1455) were removed — OAuth is now handled by the workspace CLIProxyAPI with callbacks delivered via WS (`cliproxy_oauth_callback`)

Auth: Bridges created via Tauri deep link receive a per-bridge `BRIDGE_TOKEN` from `POST /api/bridges` (passed as env var). Legacy bridges (docker-compose dev) use `ROUTER_SECRET` mounted at `/run/secrets/router_secret`. `server.js` accepts either.

**Auto-discovery flow**: When started with `BRIDGE_TOKEN` + `BRIDGE_ID` env vars (from Tauri deep link provisioning), the bridge authenticates directly with the router WS. Legacy flow: when started with `PAIRING_CODE` env var, the bridge calls `POST /api/bridges/claim-device` to exchange the code (5-min TTL) for a unique `bridgeId` + `bridgeToken`. After connecting to the router WS, the router sends `scan_bridges`; the bridge scans Docker for sibling bridge containers and reports back. Router responds with `bridge_adopt` (join existing stack) or `bridge_primary` (recreate with mapped ports).

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
