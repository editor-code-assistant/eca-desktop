# ECA Desktop

A modern, cross-platform desktop client for [ECA (Editor Code Assistant)](https://eca.dev). Built with Electron, designed for developers and non-developers alike.

[![CI](https://github.com/editor-code-assistant/eca-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/editor-code-assistant/eca-desktop/actions/workflows/ci.yml)
[![Release](https://github.com/editor-code-assistant/eca-desktop/actions/workflows/release.yml/badge.svg)](https://github.com/editor-code-assistant/eca-desktop/actions/workflows/release.yml)
[![GitHub Release](https://img.shields.io/github/v/release/editor-code-assistant/eca-desktop?label=latest)](https://github.com/editor-code-assistant/eca-desktop/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)

## Download

Get the latest release for your platform from [**GitHub Releases**](https://github.com/editor-code-assistant/eca-desktop/releases/latest):

| Platform | Architecture          | Formats              |
|----------|-----------------------|----------------------|
| macOS    | Intel (x64)           | `.dmg`, `.zip`       |
| macOS    | Apple Silicon (arm64) | `.dmg`, `.zip`       |
| Linux    | x64                   | `.AppImage`, `.deb`  |
| Linux    | arm64                 | `.AppImage`, `.deb`  |

Release assets are published with [SLSA build provenance](https://slsa.dev/) so you can verify they were built by this repository's CI.

> **Auto-updates:** `.dmg`, `.zip`, and `.AppImage` update in place via `electron-updater`.
> `.deb` does **not** auto-update — upgrade by downloading a fresh `.deb` from Releases (or via `apt` once an apt repository is published).

> The ECA server binary is downloaded automatically on first launch — no extra setup needed.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Electron App                        │
│                                                      │
│  ┌──────────────┐    IPC (contextBridge)   ┌────────────────────┐
│  │  Main Process │◄───────────────────────►│ Renderer (Chromium) │
│  │               │                          │                    │
│  │  server.ts    │    JSON-RPC / stdio      │  eca-webview       │
│  │  rpc.ts       │◄──────────────────┐      │  (React SPA)       │
│  │  bridge.ts    │                   │      │                    │
│  │  menu.ts      │                   ▼      └────────────────────┘
│  │  updater.ts   │           ┌──────────────┐
│  └──────────────┘            │  ECA Server   │
│                              │  (native bin) │
│  ┌──────────────┐            └──────────────┘
│  │ Preload       │
│  │ preload.ts    │  ← secure contextBridge
│  └──────────────┘
└─────────────────────────────────────────────────────┘
```

- **Main process**: Manages the ECA server binary (download, lifecycle) and bridges IPC ↔ JSON-RPC
- **Renderer**: Loads `eca-webview` (shared React SPA) via the pluggable `__ecaWebTransport` interface
- **Preload**: Exposes a minimal, secure API via `contextBridge` (no `nodeIntegration`)

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- npm

## Setup

```bash
# Clone with submodules
git clone --recursive https://github.com/editor-code-assistant/eca-desktop.git
cd eca-desktop

# Install dependencies
npm install

# Install webview dependencies
cd eca-webview && npm install && cd ..
```

## Development

```bash
# Start dev mode (Vite dev server + Electron with hot reload)
npm run dev
```

This runs the eca-webview Vite dev server on `localhost:5173` and launches Electron pointing to it.

### NixOS

A `shell.nix` is provided that sets up the correct environment automatically — including a NixOS-patched Electron binary via `ELECTRON_OVERRIDE_DIST_PATH`:

```bash
# Enter the dev shell (provides Node.js + patched Electron)
nix-shell

# Then use npm scripts as usual
npm install
npm run build
npm start       # run production build
npm run dev     # dev mode with hot reload
```

> **Note:** On NixOS, the npm-bundled Electron binary won't work due to FHS assumptions. Always use `nix-shell` which provides a properly patched Electron. If you encounter GPU issues, set `ECA_DISABLE_GPU=1` before running.

## Building

```bash
# Build everything (webview + main + preload)
npm run build

# Package for current platform
npm run package

# Package for specific platform
npm run package:mac
npm run package:linux
```

Packaged installers are output to the `release/` directory.

## Project Structure

```
eca-desktop/
├── eca-webview/              # Shared UI (git submodule)
├── src/
│   ├── main/
│   │   ├── main.ts           # Electron entry point
│   │   ├── server.ts         # ECA server download & lifecycle
│   │   ├── rpc.ts            # JSON-RPC API definitions
│   │   ├── bridge.ts         # IPC ↔ JSON-RPC message routing
│   │   ├── menu.ts           # Application menu
│   │   └── updater.ts        # Auto-update via electron-updater
│   ├── preload/
│   │   └── preload.ts        # Secure context bridge
│   └── renderer/
│       └── index.html        # Host page for eca-webview
├── resources/                # App icons
├── package.json
├── tsconfig.json
├── electron-builder.yml
└── README.md
```

## Platforms

| Platform | Status |
|----------|--------|
| macOS (Intel & Apple Silicon) | ✅ Supported |
| Linux (x64 & arm64) | ✅ Supported |
| Windows | 🔮 Planned |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and how to submit changes.

## License

[Apache-2.0](LICENSE)
