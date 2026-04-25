# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Chat trust indicator stays in sync with the server's persisted per-chat trust
  state on resume by bumping `eca-webview` to honor `selectTrust` on
  `config/updated` (eca #426).

## [0.6.0]

### Added

- Sidebar now auto-populates with the workspace's prior chats on app launch,
  using the new ECA `chat/list` protocol request. Clicking a previously-persisted
  chat transparently hydrates it via `chat/open`, so reopening the app no longer
  requires a manual `/resume`.
- **Security hardening**:
  - `sandbox: true` on every `BrowserWindow` (main + preferences), with explicit
    `webSecurity: true` asserted.
  - Content-Security-Policy now injected as an HTTP header via
    `session.webRequest.onHeadersReceived`, not just a `<meta>` tag — applies
    to dev-mode URLs too.
  - `'unsafe-inline'` removed from `script-src`; inline bootstrap scripts
    extracted to dedicated `index-bootstrap.ts` / `preferences-bootstrap.ts`
    bundles.
  - URL allowlist (`http:`, `https:`, `mailto:` only) around
    `shell.openExternal` calls, with credential-stripping via a new
    `security/url-allowlist.ts` utility.
  - Workspace path-scope guard around `shell.openPath` and `openFile` editor
    actions, via a new `security/path-scope.ts` utility (defeats symlink
    escapes with `fs.realpathSync`).
  - `will-navigate` + `setPermissionRequestHandler` handlers added — all
    off-origin navigations denied, all permission requests denied by default.
  - Supply-chain integrity: downloaded ECA server binaries are verified
    against the release's `sha256sums.txt` before extraction; HTTP status
    codes are now checked and partial files cleaned up on failure.
  - Size caps on `writeGlobalConfig` (1 MB) and `saveClipboardImage` (20 MB).
  - IPC trusted-sender check on the main `webview-message` channel.
  - Preload `send` passthrough now validates `message.type` is a string.
  - macOS entitlements tightened: removed `disable-library-validation`,
    `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`.
- **Server lifecycle hardening**:
  - `initialize` JSON-RPC request now has a 30s hard timeout; a hung server
    no longer locks the UI in `Starting` indefinitely.
  - `stop()` escalates SIGTERM → SIGKILL after a 3s grace period so wedged
    servers can't block app quit.
  - Auto-restart on unexpected crash, up to 3 attempts with exponential
    backoff (1s / 2s / 4s); gives up cleanly after exhausting retries.
  - `before-quit` now properly `preventDefault()`s, awaits every session's
    graceful stop, then `app.exit(0)` — no more zombie `eca` child processes.
  - `SessionManager.removeSession` is now async and awaits the underlying
    server stop; session-scoped caches (MCP, providers, config) are evicted
    via a `session-removed` event listener.
  - `downloadFile` now retries 3 times with exponential backoff on transient
    failures (previously: 1 retry).
  - Workspace URIs decoded with `fileURLToPath` instead of `new URL(...).pathname`,
    fixing paths with spaces / unicode.
  - Dev-mode `fs.watch({ recursive: true })` replaced with a tree-walking
    non-recursive watcher — reliable on Linux (previously broken).
  - New version-compatibility check: logs a warning when the connected ECA
    server is older than the declared `MIN_SERVER_VERSION`.
- **Menu & CLI**:
  - Fixed a duplicate `CmdOrCtrl+B` accelerator collision in the View menu.
  - `toggleDevTools` now hidden from packaged (production) builds; shown
    automatically in `npm run dev`.
  - Dev-mode detection unified on `!app.isPackaged` (canonical Electron
    idiom) instead of `process.env.NODE_ENV`.
- **Testing**:
  - Added TypeScript typechecking to CI (`tsc --noEmit`) as a required step.
  - Added 8 new unit test files covering `security/url-allowlist`,
    `security/path-scope`, `menu` (with accelerator-uniqueness regression
    guard), `updater`, `server`, `session-manager`, `router`, `bridge`.
    Total test count: 201 passing.
  - Scaffolded a Playwright-based Electron smoke test
    (`tests/e2e/smoke.spec.ts`) — `@playwright/test` must be installed
    manually before running.
  - Added coverage thresholds to `vitest.config.ts`.

### Changed

- `constants.ts`: `DOWNLOAD_MAX_RETRIES` raised from 1 → 3 and paired with
  exponential backoff. New server-lifecycle constants:
  `SERVER_INIT_TIMEOUT_MS`, `SERVER_STOP_GRACE_MS`,
  `SERVER_RESTART_MAX_ATTEMPTS`, `SERVER_RESTART_BASE_DELAY_MS`,
  `MIN_SERVER_VERSION`.
- `IpcMessageType` now includes `logs/snapshot | logs/clear | logs/openFolder`
  (previously handled by string comparison that bypassed the type system).
- `editor/openFile` router handler now passes active workspace roots into
  the path-scope guard.

### Fixed

- First-run download with a transient 4xx/5xx response used to silently
  write the HTML error body to disk and produce a cryptic `extract-zip`
  failure; the downloader now validates status codes and cleans up tainted
  artifacts before retrying.
- Dev-mode live-reload on Linux, which was silently broken by
  `fs.watch({ recursive: true })` throwing `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
- Workspace folder picker handed percent-encoded paths to the server when
  the path contained spaces or unicode.

### Security

- Multiple hardening measures listed under *Added* above. Audit-driven
  response to pre-launch code review; no known exploitable issues
  addressed — defense in depth for a soon-to-be-public desktop app.

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

[Unreleased]: https://github.com/editor-code-assistant/eca-desktop/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/editor-code-assistant/eca-desktop/releases/tag/v0.6.0
[0.3.0]: https://github.com/editor-code-assistant/eca-desktop/releases/tag/v0.3.0
[0.1.0]: https://github.com/editor-code-assistant/eca-desktop/releases/tag/v0.1.0
