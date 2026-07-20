# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Inline "+ Add MCP server" form and per-row remove button (with two-step
  inline confirmation) on the Settings → MCPs tab. Wired
  `mcp/addServer`, `mcp/removeServer` requests and the `tool/serverRemoved`
  notification end-to-end through the Electron main bridge.
- Forward `chat/list` and `chat/open` requests from the embedded webview
  through to the eca server, so the webview's resume-chat picker can list
  and open persisted chats alongside the existing native sidebar.
- macOS/Linux: resolve the user's login+interactive shell env (PATH,
  HOMEBREW_PREFIX, NVM_DIR, FNM_DIR, PNPM_HOME, …) before spawning the
  ECA server, so binaries the user installed via brew/asdf/nvm/etc. are
  visible to the server and any MCP subprocesses it spawns — fixing the
  long-standing "GUI app launched from Finder/launchctl can't find my
  tools" issue. Cached singleton, 10s timeout (clamped 1–120s,
  configurable via `shellEnvResolutionTimeoutMs`), skipped on Windows or
  when launched from a terminal. Sets `ECA_RESOLVING_ENVIRONMENT=1` on
  the spawned shell so users can guard slow dotfile blocks (tmux
  auto-attach, ssh-agent, …). Opt-out via the `resolveShellEnv` pref or
  the `ECA_SKIP_SHELL_ENV=1` env var.
- Retry transient failures on the GitHub releases API and
  `sha256sums.txt` fetches with exponential backoff (1s/2s/4s, up to 4
  attempts). Previously a single network blip would silently skip
  SHA-256 verification or force the cached-binary fallback.

### Fixed
- Handle `editor/readInput` from the webview with a native modal input
  dialog (text/secret input or method pick list), fixing provider login
  on Settings → Providers which previously logged
  "[Router] Unhandled message type: editor/readInput" and hung.
- Queue webview messages that arrive while the ECA server is still
  starting and replay them once it reaches Running, instead of dropping
  them ("Server not ready, dropping message: providers/list") and
  leaving request/response UIs (e.g. the Providers tab) hanging on the
  30s webview timeout.
- Stop button now takes effect promptly during fast streaming (#11).
  Streamed `chat/contentReceived` events are coalesced in the main process
  and delivered as `chat/batchContentReceived` batches (~30/s), so the
  webview no longer renders once per token and user input isn't queued
  behind the stream.
- Chat-scoped messages (`chat/promptStop`, tool approve/reject, steer, …)
  are now routed to the session that owns the chat instead of the active
  one, so stopping a chat generating in a background workspace works.
- ECA server no longer self-destructs into "exited with code null" restart
  storms: a stale start attempt could kill the process of the start that
  superseded it, and one crash could spawn parallel restart loops. Start
  attempts now own their resources via a generation token, failure signals
  coalesce into a single restart timer, and exit logs include the signal.
- Server updates no longer extract the new binary over the live one while
  sessions are still executing it (macOS SIGKILLs a running process whose
  executable is rewritten). Downloads stage in a temp dir and install via
  atomic rename, single-flighted across sessions.
- Ctrl+R / window reload no longer leaves the chat input with empty
  model, agent, and variant selectors. The session config cache was
  being overwritten by per-chat scoped `config/updated` notifications
  (emitted at the end of every `chat/open`) which carry only
  `selectModel` / `selectTrust` — not the `models` / `agents` /
  `variants` arrays the selectors need. After the first chat
  selection the cumulative global config was lost, so on reload the
  `webview/ready` handshake had a stripped-down payload to replay.
  Per-chat updates now go to a separate per-chat cache; global
  updates merge (rather than overwrite) into the cumulative cache;
  both are replayed when the webview comes back.
- Closing the last session now returns to the welcome splash instead of
  leaving an empty sidebar. A stale fade-out timer from a mid-`removeSession`
  status update was firing after the welcome had been restored and undoing it.
- Clicking a chat in the native sidebar no longer throws a TypeError in the
  embedded webview. The host-driven `chat/selectChat` event was setting
  `selectedChat` to a chatId that did not yet exist in the webview's redux
  store (the server's `chat/opened` cascade arrives strictly after the
  selection event), causing `ChatContexts` to deref undefined. Fixed by
  having the webview's `selectChat` reducer mint an empty placeholder slot.
- Chat-resume picker is now readable on Light themes. The previous palette
  used `--eca-tooltip-bg` and `--eca-base-hover`, both of which the
  codebase has documented as producing dark-popup-on-light-IDE surfaces.

### Security
- Pin vulnerable transitive deps via npm `overrides`: `axios` to
  `^1.15.2` (prototype-pollution, header/CRLF injection, SSRF,
  XSRF token leak, null-byte injection), `@xmldom/xmldom` to
  `^0.8.13` (XML node injection), and `ip-address` to `^10.1.1`
  (XSS in `Address6` HTML helpers). Closes all 12 Dependabot
  alerts.
- Bump `electron` 33 -> 41 (closes 18 runtime advisories: ASAR
  integrity bypass, AppleScript injection, multiple UAFs, IPC
  spoofing, iframe permission origin confusion, header injection,
  and more) and `electron-builder` 25 -> 26 (closes 10 dev-time
  advisories in tar/node-gyp/cacache/@electron/rebuild). `npm audit`
  now reports 0 vulnerabilities. Note: packaging now requires
  Node >= 22 because of `@electron/rebuild@4`.

## [0.6.3]

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
