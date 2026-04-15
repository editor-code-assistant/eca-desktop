# ECA Desktop

A modern, cross-platform desktop client for [ECA (Editor Code Assistant)](https://eca.dev). Built with Electron, designed for developers and non-developers alike.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)
![Electron](https://img.shields.io/badge/electron-33-green)

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

## License

Apache-2.0
