# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2025-01-01

### Added

- Initial release of ECA Desktop
- Electron-based desktop client with native ECA server integration
- Multi-session support with workspace-aware server instances
- JSON-RPC communication over stdio with the ECA server
- Auto-download and lifecycle management of the ECA server binary
- Shared `eca-webview` React SPA for the chat interface
- Sidebar with chat list, session management, and new chat creation
- Auto-update support via `electron-updater` and GitHub Releases
- macOS support (Intel & Apple Silicon) with hardened runtime
- Linux support (x64 & arm64) as AppImage and .deb
- NixOS development support via `shell.nix`
- Secure renderer with `contextIsolation` and no `nodeIntegration`

[Unreleased]: https://github.com/editor-code-assistant/eca-desktop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/editor-code-assistant/eca-desktop/releases/tag/v0.1.0
