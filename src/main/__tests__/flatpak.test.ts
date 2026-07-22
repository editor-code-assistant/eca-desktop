import { describe, it, expect, afterEach } from 'vitest';

import { isFlatpak, isFlatpakPrivateXdgDir, sanitizeEnvForHost } from '../flatpak';

const ORIGINAL_FLATPAK_ID = process.env.FLATPAK_ID;

afterEach(() => {
    if (ORIGINAL_FLATPAK_ID === undefined) delete process.env.FLATPAK_ID;
    else process.env.FLATPAK_ID = ORIGINAL_FLATPAK_ID;
});

describe('isFlatpak', () => {
    it('is true when FLATPAK_ID is set', () => {
        process.env.FLATPAK_ID = 'dev.eca.desktop';
        expect(isFlatpak()).toBe(true);
    });

    it('is false outside a sandbox', () => {
        delete process.env.FLATPAK_ID;
        // The /.flatpak-info fallback only exists inside a real sandbox,
        // so on dev/CI machines this exercises the "not flatpak" path.
        expect(isFlatpak()).toBe(false);
    });
});

describe('isFlatpakPrivateXdgDir', () => {
    it('detects the per-app remap when sandboxed', () => {
        process.env.FLATPAK_ID = 'dev.eca.desktop';
        expect(isFlatpakPrivateXdgDir('/home/u/.var/app/dev.eca.desktop/config')).toBe(true);
    });

    it('honors a genuinely custom dir when sandboxed', () => {
        process.env.FLATPAK_ID = 'dev.eca.desktop';
        expect(isFlatpakPrivateXdgDir('/home/u/my-config')).toBe(false);
    });

    it('is always false outside a sandbox', () => {
        delete process.env.FLATPAK_ID;
        expect(isFlatpakPrivateXdgDir('/home/u/.var/app/dev.eca.desktop/config')).toBe(false);
    });
});

describe('sanitizeEnvForHost', () => {
    it('drops sandbox-only vars and keeps the rest', () => {
        const env = sanitizeEnvForHost({
            FLATPAK_ID: 'dev.eca.desktop',
            container: 'flatpak',
            XDG_CONFIG_HOME: '/home/u/.var/app/dev.eca.desktop/config',
            XDG_DATA_DIRS: '/app/share:/usr/share',
            LD_LIBRARY_PATH: '/app/lib',
            LD_PRELOAD: 'libzypak.so',
            PATH: '/app/bin:/usr/bin',
            HOME: '/home/u',
            MY_API_KEY: 'secret',
        });
        expect(env.FLATPAK_ID).toBeUndefined();
        expect(env.container).toBeUndefined();
        expect(env.XDG_CONFIG_HOME).toBeUndefined();
        expect(env.XDG_DATA_DIRS).toBeUndefined();
        expect(env.LD_LIBRARY_PATH).toBeUndefined();
        expect(env.LD_PRELOAD).toBeUndefined();
        // PATH is deliberately kept — see the rationale in flatpak.ts.
        expect(env.PATH).toBe('/app/bin:/usr/bin');
        expect(env.HOME).toBe('/home/u');
        expect(env.MY_API_KEY).toBe('secret');
    });

    it('does not mutate its input', () => {
        const input: NodeJS.ProcessEnv = { FLATPAK_ID: 'x', HOME: '/home/u' };
        sanitizeEnvForHost(input);
        expect(input.FLATPAK_ID).toBe('x');
    });
});
