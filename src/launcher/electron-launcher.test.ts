import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    launchElectron,
    sanitizeElectronEnvironment,
    type ElectronChild,
    type ElectronLauncherDependencies,
    type LauncherHost,
} from './electron-launcher';

type ForwardedSignal = 'SIGINT' | 'SIGTERM';

class FakeChild implements ElectronChild {
    private errorListener: ((error: Error) => void) | undefined;
    private exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    readonly sentSignals: ForwardedSignal[] = [];

    onError(listener: (error: Error) => void): void {
        this.errorListener = listener;
    }

    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
        this.exitListener = listener;
    }

    sendSignal(signal: ForwardedSignal): void {
        this.sentSignals.push(signal);
    }

    emitError(error: Error): void {
        this.errorListener?.(error);
    }

    emitExit(code: number | null, signal: NodeJS.Signals | null): void {
        this.exitListener?.(code, signal);
    }
}

function createHarness(environment: NodeJS.ProcessEnv = {}): {
    child: FakeChild;
    dependencies: ElectronLauncherDependencies;
    emitHostSignal(signal: ForwardedSignal): void;
    setExitCode: ReturnType<typeof vi.fn>;
    terminateWithSignal: ReturnType<typeof vi.fn>;
    writeError: ReturnType<typeof vi.fn>;
    spawnElectron: ReturnType<typeof vi.fn>;
} {
    const child = new FakeChild();
    const listeners = new Map<ForwardedSignal, () => void>();
    const setExitCode = vi.fn<(code: number) => void>();
    const terminateWithSignal = vi.fn<(signal: NodeJS.Signals) => void>();
    const writeError = vi.fn<(message: string) => void>();
    const host: LauncherHost = {
        environment,
        listenForSignal: (signal, listener) => {
            listeners.set(signal, listener);
            return () => { listeners.delete(signal); };
        },
        setExitCode,
        terminateWithSignal,
        writeError,
    };
    const spawnElectron = vi.fn(() => child);

    return {
        child,
        dependencies: {
            resolveExecutable: () => 'C:\\tools\\electron.exe',
            spawnElectron,
            host,
        },
        emitHostSignal: (signal) => { listeners.get(signal)?.(); },
        setExitCode,
        terminateWithSignal,
        writeError,
        spawnElectron,
    };
}

describe('sanitizeElectronEnvironment', () => {
    it('removes every case variant of ELECTRON_RUN_AS_NODE without mutating the source', () => {
        const source = {
            PATH: 'C:\\tools',
            ELECTRON_RUN_AS_NODE: '1',
            electron_run_as_node: 'also-set',
        };

        expect(sanitizeElectronEnvironment(source)).toEqual({ PATH: 'C:\\tools' });
        expect(source).toHaveProperty('ELECTRON_RUN_AS_NODE', '1');
    });
});

describe('launchElectron', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('launches Electron with sanitized environment and unchanged arguments', () => {
        const harness = createHarness({ PATH: 'C:\\tools', ELECTRON_RUN_AS_NODE: '1' });

        launchElectron(['.', '--inspect=9229'], harness.dependencies);

        expect(harness.spawnElectron).toHaveBeenCalledWith(
            'C:\\tools\\electron.exe',
            ['.', '--inspect=9229'],
            { PATH: 'C:\\tools' },
        );
    });

    it('forwards termination signals to the child and removes listeners after exit', () => {
        const harness = createHarness();
        launchElectron(['.'], harness.dependencies);

        harness.emitHostSignal('SIGINT');
        harness.child.emitExit(0, null);
        harness.emitHostSignal('SIGTERM');

        expect(harness.child.sentSignals).toEqual(['SIGINT']);
        expect(harness.setExitCode).toHaveBeenCalledWith(0);
    });

    it('propagates non-zero exit codes', () => {
        const harness = createHarness();
        launchElectron(['.'], harness.dependencies);

        harness.child.emitExit(17, null);

        expect(harness.setExitCode).toHaveBeenCalledWith(17);
    });

    it('propagates signal-based child termination', () => {
        const harness = createHarness();
        launchElectron(['.'], harness.dependencies);

        harness.child.emitExit(null, 'SIGTERM');

        expect(harness.terminateWithSignal).toHaveBeenCalledWith('SIGTERM');
    });

    it('reports asynchronous launch errors exactly once', () => {
        const harness = createHarness();
        launchElectron(['.'], harness.dependencies);

        harness.child.emitError(new Error('spawn denied'));
        harness.child.emitExit(-1, null);

        expect(harness.writeError).toHaveBeenCalledOnce();
        expect(harness.writeError).toHaveBeenCalledWith('Failed to launch Electron: spawn denied\n');
        expect(harness.setExitCode).toHaveBeenCalledOnce();
        expect(harness.setExitCode).toHaveBeenCalledWith(1);
    });

    it('reports synchronous executable resolution failures', () => {
        const harness = createHarness();
        harness.dependencies.resolveExecutable = () => { throw new Error('module missing'); };

        launchElectron(['.'], harness.dependencies);

        expect(harness.spawnElectron).not.toHaveBeenCalled();
        expect(harness.writeError).toHaveBeenCalledWith('Failed to launch Electron: module missing\n');
        expect(harness.setExitCode).toHaveBeenCalledWith(1);
    });
});
