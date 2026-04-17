# xAI Workspace Desktop

Lightweight cross-platform system tray app that launches the xAI Workspace system bridge Docker container.

## What it does

1. **Installs Docker** — Downloads and installs Docker Desktop (macOS/Windows) or Docker Engine (Linux) if not present
2. **Runs the bridge** — Pulls and starts the bridge container from ECR with health monitoring
3. **Device pairing** — Opens browser for zero-click account linking via pairing code
4. **System tray** — Sits quietly in the tray

OAuth for CLI model providers (Claude, Gemini, Codex) is handled by the workspace CLIProxyAPI mini-app — callbacks are delivered via WebSocket (`cliproxy_oauth_callback`), not via localhost ports on this app.

## Quick start

### From release

Download the latest release for your platform:

| Platform | File | Install |
|----------|------|---------|
| Linux | `.AppImage` | `chmod +x` and run |
| macOS | `.dmg` | Drag to Applications |
| Windows | `.msi` | Run installer |

### From source

```bash
# Prerequisites: Rust, Node.js 22+, pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Linux only — install system dependencies
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev libsoup-3.0-dev patchelf

# Build
pnpm install
pnpm tauri build
```

Output: `src-tauri/target/release/bundle/`

## Configuration

Config is loaded with priority: **local file > router API > defaults**.

### Local config file (dev/test)

Place `xaiworkspace-config.json` next to the executable:

```json
{
  "bridgeImage": "xaiworkspace-bridge:latest",
  "bridgePorts": [3100],
  "routerUrls": ["http://localhost:8080"],
  "appUrl": "http://localhost:4200"
}
```

Pre-made configs in `config/`:
- `config/dev.json` — local development (localhost router + frontend)
- `config/test.json` — test environment

### Router API config (production)

In production (no local file), the app fetches config from `GET /api/config/desktop` on the router. This allows changing the bridge image or URLs without rebuilding the app.

### Defaults

If both local file and router API fail, hardcoded defaults are used:
- Image: `public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-latest`
- Router: `https://router.xaiworkspace.com`
- App: `https://app.xaiworkspace.com`

## Architecture

```
Tauri (system tray)          Bridge (Docker)           Router (brain)
──────────────────           ──────────────            ──────────────
Install Docker (once)        Relay commands            Manages everything
Run bridge container         Docker/pm2 pipe           Users, instances,
Single instance guard        Serve localhost:3100      pairing codes,
                             (pairing redirect)        OAuth tokens
```

- **Router** is the only smart component — manages users, instances, pairing codes
- **System bridge** (`bridge/`) is a pipe — relays between router and Docker, auto-updates
- **Workspace agent** (`workspace-base/`) runs inside each workspace container — installs apps, executes commands. OAuth for CLI model providers is handled here by the CLIProxyAPI mini-app, with callbacks delivered via WebSocket.
- **Tauri** is a launcher — starts the system bridge Docker container, sits in tray

## System tray

```
┌─────────────────────────────┐
│ Open xAI Workspace          │
│ Bridge: checking...         │
│ ─────────────────────────── │
│ Quit                        │
└─────────────────────────────┘
```

## Bridge Docker image

The bridge image is **multi-arch** (`linux/amd64` + `linux/arm64`) and published from `Dockerfile.bridge` to `public.ecr.aws/s3b3q6t2/xaiworkspace-docker`.

```bash
# One-time ECR login (token lasts ~12h)
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws

# Build + push multi-arch manifest (both tags: bridge-vX.Y.Z + bridge-latest)
./scripts/push-bridge.sh
```

First run auto-provisions a buildx builder and registers QEMU binfmt handlers for cross-arch builds. See `CLAUDE.md` for details, including the local single-arch test command.

## Code signing

macOS builds are signed and notarized via GitHub Actions. Secrets required:

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` signing certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` file |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: xShopper Pty Ltd (D3BS8AH5D9)` |
| `APPLE_TEAM_ID` | `D3BS8AH5D9` |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | App-specific password for notarization |

## Linux installation

GNOME 46+ doesn't run executables from the file manager. Install as a desktop app:

```bash
# Copy AppImage
mkdir -p ~/.local/bin
cp "xAI Workspace_0.1.0_amd64.AppImage" ~/.local/bin/xaiworkspace.AppImage
chmod +x ~/.local/bin/xaiworkspace.AppImage

# Create desktop entry
cat > ~/.local/share/applications/xaiworkspace.desktop << 'EOF'
[Desktop Entry]
Name=xAI Workspace
Exec=$HOME/.local/bin/xaiworkspace.AppImage --appimage-extract-and-run
Icon=xaiworkspace
Type=Application
Categories=Development;Utility;
Terminal=false
EOF
```

## License

Proprietary — xShopper Pty Ltd
