# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sidebar now auto-populates with the workspace's prior chats on app launch,
  using the new ECA `chat/list` protocol request. Clicking a previously-persisted
  chat transparently hydrates it via `chat/open`, so reopening the app no longer
  requires a manual `/resume`.

## [0.3.0] - 2026-04-16

### Added

- Smooth hero → chat transition: the prompt card now glides from the
  centered empty-state position to the bottom with a spring animation
  (framer-motion `layout="position"`) instead of snapping.
- Welcome message fades out gracefully as the first message arrives.

### Changed

- Progress bar ("Generating…") is now rendered inside the prompt card
  as an inline row that expands/collapses smoothly, instead of being a
  separate sibling card above the prompt. This eliminates the animation
  desync that was visible in big/hero modes and simplifies the CSS.
- Consolidated all prompt area styling (including the hero variant) in
  the webview component; removed the now-redundant big-mode
  `.progress-area` rules and `:has(+ ...)` sibling selectors from the
  theme.

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

[Unreleased]: https://github.com/editor-code-assistant/eca-desktop/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/editor-code-assistant/eca-desktop/releases/tag/v0.3.0
[0.1.0]: https://github.com/editor-code-assistant/eca-desktop/releases/tag/v0.1.0
