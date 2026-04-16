# Contributing to ECA Desktop

Thank you for your interest in contributing! This guide will help you get set up and understand our development workflow.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- npm
- Git (with submodule support)

### Setup

```bash
# Clone with submodules
git clone --recursive https://github.com/editor-code-assistant/eca-desktop.git
cd eca-desktop

# Install dependencies
npm install

# Install webview dependencies
cd eca-webview && npm install && cd ..

# Start development
npm run dev
```

### NixOS Users

Use the provided `shell.nix`:

```bash
nix-shell
npm install
npm run dev
```

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/main/` | Electron main process — server lifecycle, IPC bridge, menu, updater |
| `src/preload/` | Secure context bridge between main and renderer |
| `src/renderer/` | Host HTML page, sidebar, welcome screen, styles |
| `eca-webview/` | Shared React SPA (git submodule) |
| `resources/` | App icons and static assets |

## Development Workflow

### Running in Dev Mode

```bash
npm run dev
```

This starts the webview Vite dev server on `localhost:5173` and launches Electron pointing to it, with hot reload for the renderer.

### Building

```bash
npm run build           # Build all (webview + main + preload + renderer)
npm run package         # Build + package for current platform
npm run package:mac     # Package for macOS
npm run package:linux   # Package for Linux
```

### Linting

```bash
npm run lint
```

We use ESLint with `typescript-eslint` in strict mode. Please ensure your changes pass linting before submitting.

### Testing

```bash
npm test
```

## Submitting Changes

1. **Fork** the repository and create a feature branch from `main`
2. **Make your changes** with clear, descriptive commits
3. **Ensure** `npm run lint` and `npm test` pass
4. **Open a Pull Request** against `main` with a clear description of what and why

### Commit Messages

Use clear, imperative-mood commit messages:

- ✅ `Add session persistence across restarts`
- ✅ `Fix server download retry on timeout`
- ❌ `fixed stuff`
- ❌ `WIP`

## Architecture Notes

ECA Desktop follows a three-layer architecture:

- **Main Process** (`bridge.ts`, `router.ts`): Orchestrates IPC messages from the renderer and JSON-RPC messages from the ECA server. The `router.ts` data-driven dispatch table is the central routing mechanism.
- **ECA Server** (`server.ts`, `rpc.ts`): Manages downloading, spawning, and communicating with the native ECA binary over stdio using JSON-RPC.
- **Renderer** (`eca-webview`): The shared React SPA communicates via the `__ecaWebTransport` interface, bridged through `contextBridge` in `preload.ts`.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
