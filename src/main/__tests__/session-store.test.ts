import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { sameWorkspaceUri, workspaceDisplayPath } from '../session-store';

describe('sameWorkspaceUri', () => {
    const origPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: origPlatform });
    });

    it('is case-sensitive on POSIX', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        expect(sameWorkspaceUri('file:///home/user/Proj', 'file:///home/user/proj')).toBe(false);
        expect(sameWorkspaceUri('file:///home/user/proj', 'file:///home/user/proj')).toBe(true);
    });

    it('is case-insensitive on win32 (drive letter and path casing)', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        expect(sameWorkspaceUri('file:///C:/Users/Greg/Proj', 'file:///c:/users/greg/proj')).toBe(true);
        expect(sameWorkspaceUri('file:///C:/Users/a', 'file:///C:/Users/b')).toBe(false);
    });
});

describe('workspaceDisplayPath', () => {
    // Assertions are host-platform-aware so they hold on Windows CI too
    // (no ~ shortening there; native separators come from fileURLToPath).
    const isWin = process.platform === 'win32';

    it('returns the raw string for unparseable URIs', () => {
        expect(workspaceDisplayPath('not-a-uri')).toBe('not-a-uri');
    });

    it('shortens the home directory to ~ on POSIX hosts', () => {
        const p = path.join(os.homedir(), 'proj');
        const expected = isWin ? p : '~' + path.sep + 'proj';
        expect(workspaceDisplayPath(pathToFileURL(p).href)).toBe(expected);
    });

    it('decodes percent-encoded characters', () => {
        const p = path.join(os.homedir(), 'My Code');
        const expected = isWin ? p : '~' + path.sep + 'My Code';
        expect(workspaceDisplayPath(pathToFileURL(p).href)).toBe(expected);
    });

    it('leaves paths outside the home directory absolute', () => {
        const p = path.resolve(path.sep, 'opt', 'x');
        expect(workspaceDisplayPath(pathToFileURL(p).href)).toBe(p);
    });
});
