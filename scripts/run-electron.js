// Launch Electron as a GUI app regardless of the caller's environment.
// The previous `unset ELECTRON_RUN_AS_NODE && electron .` breaks on
// Windows shells (no `unset` in cmd/PowerShell), and a leaked
// ELECTRON_RUN_AS_NODE=1 (e.g. from an editor-spawned terminal) makes
// `electron .` run as plain Node instead of booting the app.
const { spawn } = require('child_process');
const electron = require('electron'); // resolves to the electron binary path under plain Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
});
