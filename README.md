# ECA Desktop

[![CI](https://github.com/editor-code-assistant/eca-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/editor-code-assistant/eca-desktop/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/editor-code-assistant/eca-desktop?label=latest)](https://github.com/editor-code-assistant/eca-desktop/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)

![demo](./demo.gif)

ECA (Editor Code Assistant) Desktop is an AI-powered pair-programming client that runs as a standalone desktop app — no editor required.
It connects to an external `eca` server process to provide interactive chat, code suggestions, context management and more.

The rationale came from being able to offer all ECA server capabilities that are a lot in an easy way without requiring an editor, since most logic lives in ECA server, ECA Desktop is a thin wrapper layer re-using [eca-webview](https://github.com/editor-code-assistant/eca-webview).

For more details about ECA, features and configuration, check [ECA server](https://github.com/editor-code-assistant/eca).

This app will auto download `eca` and manage the process.

## Install

Grab the latest installer for your platform from [**GitHub Releases**](https://github.com/editor-code-assistant/eca-desktop/releases/latest):

| Platform | Architecture          | Formats                         |
|----------|-----------------------|---------------------------------|
| macOS    | Intel (x64)           | `.dmg`, `.zip`                  |
| macOS    | Apple Silicon (arm64) | `.dmg`, `.zip`                  |
| Linux    | x64                   | `.AppImage`, `.deb`, `.flatpak` |
| Linux    | arm64                 | `.AppImage`, `.deb`             |

For the Flatpak bundle:

```bash
flatpak install --user ./eca-linux-x64.flatpak
flatpak run dev.eca.desktop
```

Release assets are published with [SLSA build provenance](https://slsa.dev/) so you can verify they were built by this repository's CI.

> **Auto-updates:** `.dmg`, `.zip`, and `.AppImage` update in place via `electron-updater`.
> `.deb` does **not** auto-update — upgrade by downloading a fresh `.deb` from Releases.
> `.flatpak` app updates are owned by Flatpak — until ECA is on Flathub, upgrade by installing a fresh bundle. The managed `eca` server keeps auto-updating in every format.

## Settings

Open **Settings** from the app menu to configure the `eca` server path, extra server args, and other preferences.

## Troubleshooting

Check [troubleshooting](https://eca.dev/troubleshooting) docs section.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- npm

### Setup

Make sure that you have the `eca-webview` submodule cloned:

```bash
git clone --recursive https://github.com/editor-code-assistant/eca-desktop.git
cd eca-desktop
npm install
```

If you already cloned without `--recursive`:

```bash
git submodule update --init --recursive
```

### Run locally

```bash
npm run dev
```

This starts the [eca-webview](https://github.com/editor-code-assistant/eca-webview) Vite dev server on `http://localhost:5173` and launches Electron pointing to it, so any changes will be updated on the desktop app live.

#### Reusing a running webview across clients

If you already have an `eca-webview` Vite dev server running (for example one started by `eca-vscode` or `eca-intellij`), you can boot only the desktop side and have it connect to that same webview:

```bash
# Terminal A — the webview only (or already running from another client)
npm run dev:webview

# Terminal B — the desktop only, connects to http://localhost:5173 by default
npm run dev:app
```

Override the URL with the `ECA_WEBVIEW_URL` env var to point at a non-default host/port:

```bash
ECA_WEBVIEW_URL=http://localhost:6000 npm run dev:app
```

### Package

```bash
npm run package           # current platform
npm run package:mac       # macOS
npm run package:linux     # Linux (AppImage + deb)
npm run package:flatpak   # Linux (Flatpak bundle, x64)
```

Installers are written to `release/`.

The Flatpak target additionally requires `flatpak` and `flatpak-builder` installed, plus the shared runtimes:

```bash
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08
```

When sandboxed, the app spawns the `eca` server on the **host** via `flatpak-spawn --host` (permission `--talk-name=org.freedesktop.Flatpak`) so the agent can use your real toolchain (git, shells, MCP servers), falling back to an in-sandbox server if the portal is unavailable.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more details.

## Platforms

| Platform | Status |
|----------|--------|
| macOS (Intel & Apple Silicon) | ✅ Supported |
| Linux (x64 & arm64) | ✅ Supported |
| Windows | 🔮 Planned |

## Contributing 💙

Contributions are very welcome, please open an issue for discussion or a pull request.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.
