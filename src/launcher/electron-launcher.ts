import { spawn } from 'node:child_process';

const ELECTRON_MODE_VARIABLE = 'ELECTRON_RUN_AS_NODE';
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

export interface ElectronChild {
    onError(listener: (error: Error) => void): void;
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    sendSignal(signal: ForwardedSignal): void;
}

export interface LauncherHost {
    readonly environment: NodeJS.ProcessEnv;
    listenForSignal(signal: ForwardedSignal, listener: () => void): () => void;
    setExitCode(code: number): void;
    terminateWithSignal(signal: NodeJS.Signals): void;
    writeError(message: string): void;
}

export interface ElectronLauncherDependencies {
    resolveExecutable(): string;
    spawnElectron(
        executable: string,
        arguments_: readonly string[],
        environment: NodeJS.ProcessEnv,
    ): ElectronChild;
    readonly host: LauncherHost;
}

export function sanitizeElectronEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(environment).filter(
            ([name]) => name.toUpperCase() !== ELECTRON_MODE_VARIABLE,
        ),
    );
}

function resolveElectronExecutable(): string {
    const electronModule: unknown = require('electron');
    if (typeof electronModule !== 'string' || electronModule.length === 0) {
        throw new TypeError('The electron package did not provide an executable path.');
    }
    return electronModule;
}

function spawnElectron(
    executable: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
): ElectronChild {
    const child = spawn(executable, [...arguments_], {
        env: environment,
        stdio: 'inherit',
    });

    return {
        onError: (listener) => { child.once('error', listener); },
        onExit: (listener) => { child.once('exit', listener); },
        sendSignal: (signal) => { child.kill(signal); },
    };
}

const processHost: LauncherHost = {
    environment: process.env,
    listenForSignal: (signal, listener) => {
        process.on(signal, listener);
        return () => { process.off(signal, listener); };
    },
    setExitCode: (code) => { process.exitCode = code; },
    terminateWithSignal: (signal) => { process.kill(process.pid, signal); },
    writeError: (message) => { process.stderr.write(message); },
};

const productionDependencies: ElectronLauncherDependencies = {
    resolveExecutable: resolveElectronExecutable,
    spawnElectron,
    host: processHost,
};

export function launchElectron(
    arguments_: readonly string[],
    dependencies: ElectronLauncherDependencies = productionDependencies,
): void {
    const { host } = dependencies;
    let child: ElectronChild;

    try {
        child = dependencies.spawnElectron(
            dependencies.resolveExecutable(),
            arguments_,
            sanitizeElectronEnvironment(host.environment),
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        host.writeError(`Failed to launch Electron: ${message}\n`);
        host.setExitCode(1);
        return;
    }

    let settled = false;
    const removeSignalListeners = FORWARDED_SIGNALS.map((signal) =>
        host.listenForSignal(signal, () => { child.sendSignal(signal); }),
    );
    const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        removeSignalListeners.forEach((removeListener) => { removeListener(); });
        action();
    };

    child.onError((error) => {
        settle(() => {
            host.writeError(`Failed to launch Electron: ${error.message}\n`);
            host.setExitCode(1);
        });
    });
    child.onExit((code, signal) => {
        settle(() => {
            if (code !== null) {
                host.setExitCode(code);
            } else if (signal !== null) {
                host.terminateWithSignal(signal);
            }
        });
    });
}
