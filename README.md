# xAI Workspace Desktop

Lightweight cross-platform system tray app that launches the xAI Workspace system bridge Docker container.

## What it does

1. **Installs Docker** — Downloads and installs Docker Desktop (macOS/Windows) or Docker Engine (Linux) if not present
2. **Runs the bridge** — Pulls and starts the bridge container from ECR with health monitoring
3. **Device pairing** — Opens browser for zero-click account linking via pairing code
4. **OAuth interception** — Listens on localhost callback ports (Claude, Gemini, Codex) and forwards to the router
5. **System tray** — Sits quietly in the tray with per-provider OAuth port toggles

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
  "bridgePorts": [3100, 54545, 8085, 1455],
  "oauthProviders": [
    { "name": "claude", "port": 54545 },
    { "name": "gemini", "port": 8085 },
    { "name": "codex", "port": 1455 }
  ],
  "routerUrl": "http://localhost:8080",
  "appUrl": "http://localhost:4200"
}
```

Pre-made configs in `config/`:
- `config/dev.json` — local development (localhost router + frontend)
- `config/test.json` — test environment

### Router API config (production)

In production (no local file), the app fetches config from `GET /api/config/desktop` on the router. This allows changing the bridge image, OAuth ports, or URLs without rebuilding the app.

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
Listen OAuth ports           Serve localhost:3100      pairing codes,
Forward to router            (pairing redirect)        OAuth tokens
Toggle ports on/off
Single instance guard
```

- **Router** is the only smart component — manages users, instances, pairing codes
- **System bridge** (`bridge/`) is a pipe — relays between router and Docker, handles OAuth callbacks, auto-updates
- **Workspace agent** (`workspace-base/`) runs inside each workspace container — installs apps, executes commands
- **Tauri** is a launcher — starts the system bridge Docker container, sits in tray

## System tray

```
┌─────────────────────────────┐
│ Open xAI Workspace          │
│ Bridge: checking...         │
│ ─────────────────────────── │
│ ✓ Claude (port 54545)       │  ← click to toggle
│ ✓ Gemini (port 8085)        │
│ ✓ Codex (port 1455)         │
│ ─────────────────────────── │
│ Quit                        │
└─────────────────────────────┘
```

OAuth ports are on by default. If the bridge container maps the same ports, Tauri silently skips them (bridge handles OAuth). Toggle off ports you don't need.

## Bridge Docker image

The bridge image is built from `Dockerfile.bridge` and published to ECR:

```bash
# Build locally
docker build -f Dockerfile.bridge -t xaiworkspace-bridge:latest .

# Push to ECR
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws/s3b3q6t2
docker tag xaiworkspace-bridge:latest public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-latest
docker push public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-latest
```

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
