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

| Platform | Architecture          | Formats              |
|----------|-----------------------|----------------------|
| macOS    | Intel (x64)           | `.dmg`, `.zip`       |
| macOS    | Apple Silicon (arm64) | `.dmg`, `.zip`       |
| Linux    | x64                   | `.AppImage`, `.deb`  |
| Linux    | arm64                 | `.AppImage`, `.deb`  |

Release assets are published with [SLSA build provenance](https://slsa.dev/) so you can verify they were built by this repository's CI.

> **Auto-updates:** `.dmg`, `.zip`, and `.AppImage` update in place via `electron-updater`.
> `.deb` does **not** auto-update — upgrade by downloading a fresh `.deb` from Releases.

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

### Package

```bash
npm run package           # current platform
npm run package:mac       # macOS
npm run package:linux     # Linux
```

Installers are written to `release/`.

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
