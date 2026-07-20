# Windows support fix plan

Findings from the Windows compatibility audit (2026-07-20), grouped in work batches.
Workflow: fix one batch, patch release, then move to the next batch.

Verified fine (no action): artifact mapping & `eca.exe` handling, chmod/`X_OK` guards,
`%APPDATA%` fallback, shell-env no-op on win32, menu accelerators (`CmdOrCtrl`),
atomic writes/temp dirs, CRLF-safe parsers, CSP `file://` matching, preload.

## Batch 1 — High (broken functionality) — released in v0.9.1

- [x] **openFile dead on Windows** — `src/main/router.ts:318`
  Workspace roots derived with `new URL(uri).pathname` → `/C:/Users/...` garbage, scope
  check rejects every `editor/openFile`. Fix: use `fileURLToPath` (same fix as `main.ts:349`).
- [x] **Server binary update fails while another session runs** — `src/main/server.ts:679`
  Windows can't rename-over or unlink a running `eca.exe`; fallback throws, start fails,
  auto-restart re-downloads and fails again. Fix: rename-aside pattern (remove stale
  `eca.exe.old`, rename running exe to `.old`, rename staged into place).
- [x] **Console window flash** — `src/main/server.ts:848`
  `spawn` without `windowsHide: true` allocates a visible console for the server process.

## Batch 2 — Medium (robustness)

- [ ] **Orphaned MCP/tool subprocesses on force-kill** — `src/main/server.ts:789,1035,1199`
  `SIGTERM`/`SIGKILL` map to `TerminateProcess` on the direct child only. Fix: on win32 use
  `taskkill /pid <pid> /T /F` for the force-kill paths (graceful JSON-RPC shutdown already
  runs first in `stop()`).
- [ ] **No single-instance lock** — `src/main/main.ts`
  Double-launch (common on Windows) → two processes sharing `~/.eca-desktop` (sessions.json,
  logs, concurrent downloads; compounds the update-over-running-exe issue). Fix:
  `app.requestSingleInstanceLock()` + focus existing window on `second-instance`.
- [ ] **No `app.setAppUserModelId`** — `src/main/main.ts`
  Taskbar grouping/pinning quirks; future `Notification` would silently fail. Fix: call
  `app.setAppUserModelId('dev.eca.desktop')` on win32 at startup.

## Batch 3 — Low (edge cases & cosmetics)

- [ ] **Custom server binary validation weak on win32** — `src/main/main.ts:275`
  Any file passes; `.cmd`/`.bat` later throws `EINVAL` at spawn (Node >= 20, no shell).
  Fix: require `.exe` on win32.
- [ ] **Case-sensitive URI compares dedup** — `src/main/main.ts:371`, `src/main/session-store.ts:46`
  Windows FS is case-insensitive; same folder can duplicate sessions/recents. Fix:
  normalize (e.g. lowercase drive letter / case-insensitive compare on win32).
- [ ] **`XDG_CONFIG_HOME` beats `%APPDATA%` on win32** — `src/main/constants.ts:53`
  Desktop may edit a config the server never reads. Confirm the eca server's own resolution
  order first, then align.
- [ ] **Recents path display** — `src/renderer/welcome.ts:227`
  Shows `/C:/Users/My%20Code`; `~` shortening assumes `/home/` (also wrong on macOS).
  Fix: decode + strip leading slash on win32, shorten against `os.homedir()` (via preload).
- [ ] **Hardcoded `⌘B` tooltip** — `src/renderer/sidebar.ts:105,130`
  Show `Ctrl+B` off-mac (`window.ecaDesktop.platform` is available).
- [ ] **Un-gated titlebar drag region** — `src/renderer/sidebar.css:52`
  `-webkit-app-region: drag` on `.sidebar-header` creates a stray drag strip under the
  native Windows titlebar. Gate on `.platform-darwin`.
- [ ] **Updater install-on-quit smoke test** — `src/main/updater.ts` + `main.ts:574`
  `autoInstallOnAppQuit` vs `before-quit` `preventDefault()`/`app.exit(0)` interplay needs a
  manual Windows test of the "Later, install on quit" path.
- [ ] **Dev scripts fail on Windows shells** — `package.json` `dev:app`/`start` use `unset`
  (cmd/PowerShell have none). Dev-only, packaged app unaffected. Fix: cross-env or similar.
- [ ] **No win32/arm64 server artifact mapping** — `src/main/constants.ts:70`
  Fine while shipping x64-only Windows builds (arm64 runs x64 via emulation); revisit if
  upstream ever publishes windows-aarch64.

## Batch 4 — Webview (upstream `eca-webview` repo + submodule bump)

- [ ] **Systemic path display breakage** — `eca-webview/src/util.ts:13` (`uriToPath`/
  `relativizeFromRoot`): `/C:/...` leading slash, forward-vs-backslash mismatch,
  case-sensitive root compare → every context chip / file mention / file-change header
  shows the full absolute path. Also fix the `split('/')` basename logic in
  `ChatContexts.tsx:16`, `ChatFileMentions.tsx:50`, `ChatToolCall.tsx:227`.
- [ ] **URI decoding beyond `%20`** — `eca-webview/src/util.ts:15` (breaks non-ASCII users,
  e.g. `C:\Users\José`).
- [ ] **CRLF diff hunks** — `eca-webview/src/pages/chat/ChatToolCall.tsx:246` (verify
  `parseDiff` with `\r\n` server output).
- [ ] **`$` prompt glyph for shell commands** — `ChatToolCall.tsx:176` (cosmetic).
- [ ] **Non-http(s) links fall through** — `MarkdownContent.tsx:15` (`file://`/`C:\` hrefs).
