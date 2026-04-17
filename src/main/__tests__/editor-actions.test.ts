import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron — editor-actions imports `shell` at the top level.
// The open path + dialog surfaces aren't exercised in these unit tests, but
// the import must succeed.
vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
    dialog: {
        showSaveDialog: vi.fn(async () => ({ canceled: true })),
    },
    shell: {
        openPath: vi.fn(async () => ''),
        openExternal: vi.fn(async () => {}),
    },
}));

describe('getGlobalConfigPath', () => {
    const origEnv = { ...process.env };
    const origPlatform = process.platform;

    beforeEach(() => {
        // Reset the env before each test so prior mutations don't leak.
        process.env = { ...origEnv };
        delete process.env.ECA_CONFIG_PATH;
        delete process.env.XDG_CONFIG_HOME;
    });

    afterEach(async () => {
        process.env = { ...origEnv };
        Object.defineProperty(process, 'platform', { value: origPlatform });
        vi.resetModules();
    });

    async function loadConstants() {
        // Fresh require so module-level `process.platform` checks re-run.
        vi.resetModules();
        return await import('../constants');
    }

    it('honors ECA_CONFIG_PATH when set', async () => {
        process.env.ECA_CONFIG_PATH = '/custom/path/config.json';
        const { getGlobalConfigPath } = await loadConstants();
        expect(getGlobalConfigPath()).toBe('/custom/path/config.json');
    });

    it('ignores empty ECA_CONFIG_PATH and falls through', async () => {
        process.env.ECA_CONFIG_PATH = '   ';
        const { getGlobalConfigPath } = await loadConstants();
        // Should not equal the empty override; falls through to other rules.
        expect(getGlobalConfigPath()).not.toBe('   ');
        expect(getGlobalConfigPath().endsWith('config.json')).toBe(true);
    });

    it('uses XDG_CONFIG_HOME when set (and ECA_CONFIG_PATH unset)', async () => {
        process.env.XDG_CONFIG_HOME = '/some/xdg';
        const { getGlobalConfigPath } = await loadConstants();
        expect(getGlobalConfigPath()).toBe(path.join('/some/xdg', 'eca', 'config.json'));
    });

    it('uses macOS default on darwin when no env override', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const { getGlobalConfigPath } = await loadConstants();
        expect(getGlobalConfigPath()).toBe(
            path.join(os.homedir(), 'Library', 'Application Support', 'eca', 'config.json'),
        );
    });

    it('uses APPDATA on win32 when set', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
        const { getGlobalConfigPath } = await loadConstants();
        expect(getGlobalConfigPath()).toBe(
            path.join('C:\\Users\\Test\\AppData\\Roaming', 'eca', 'config.json'),
        );
    });

    it('falls back to ~/.config/eca/config.json on linux', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const { getGlobalConfigPath } = await loadConstants();
        expect(getGlobalConfigPath()).toBe(
            path.join(os.homedir(), '.config', 'eca', 'config.json'),
        );
    });
});

describe('readGlobalConfig / writeGlobalConfig / openGlobalConfig', () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-config-test-'));
        configPath = path.join(tmpDir, 'eca', 'config.json');
        process.env.ECA_CONFIG_PATH = configPath;
        vi.resetModules();
    });

    afterEach(() => {
        delete process.env.ECA_CONFIG_PATH;
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    async function loadActions() {
        return await import('../editor-actions');
    }

    it('readGlobalConfig returns exists:false with empty contents when file missing', async () => {
        const { readGlobalConfig } = await loadActions();
        const result = readGlobalConfig();
        expect(result.exists).toBe(false);
        expect(result.contents).toBe('');
        expect(result.path).toBe(configPath);
    });

    it('readGlobalConfig returns the contents when file exists', async () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{"theme":"dark"}\n', 'utf-8');
        const { readGlobalConfig } = await loadActions();
        const result = readGlobalConfig();
        expect(result.exists).toBe(true);
        expect(result.contents).toBe('{"theme":"dark"}\n');
        expect(result.path).toBe(configPath);
    });

    it('writeGlobalConfig rejects invalid JSONC and leaves disk untouched', async () => {
        const { writeGlobalConfig } = await loadActions();
        // A dangling `{` with no closing brace is an unambiguous structural
        // error under JSONC as well.
        const result = writeGlobalConfig({ contents: '{ "broken": ' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Invalid JSONC/);
        expect(fs.existsSync(configPath)).toBe(false);
    });

    it('writeGlobalConfig accepts // and /* */ comments (JSONC)', async () => {
        const { writeGlobalConfig } = await loadActions();
        const contents = [
            '// top-level comment',
            '{',
            '  /* multi-line',
            '     block comment */',
            '  "theme": "dark", // trailing comment',
            '  "models": []',
            '}',
            '',
        ].join('\n');
        const result = writeGlobalConfig({ contents });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(contents);
    });

    it('writeGlobalConfig accepts trailing commas (JSONC)', async () => {
        const { writeGlobalConfig } = await loadActions();
        const contents = '{\n  "models": [\n    "a",\n    "b",\n  ],\n}\n';
        const result = writeGlobalConfig({ contents });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(contents);
    });

    it('writeGlobalConfig still rejects clearly malformed input', async () => {
        const { writeGlobalConfig } = await loadActions();
        const result = writeGlobalConfig({ contents: 'not json at all {' });
        expect(result.ok).toBe(false);
        expect(fs.existsSync(configPath)).toBe(false);
    });

    it('writeGlobalConfig persists valid JSON and creates parent dirs', async () => {
        const { writeGlobalConfig } = await loadActions();
        const contents = '{\n  "models": [],\n  "mcp": {}\n}\n';
        const result = writeGlobalConfig({ contents });
        expect(result.ok).toBe(true);
        expect(result.path).toBe(configPath);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(contents);
    });

    it('writeGlobalConfig overwrites an existing file', async () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{"old":true}', 'utf-8');
        const { writeGlobalConfig } = await loadActions();
        const result = writeGlobalConfig({ contents: '{"old":false}' });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"old":false}');
    });

    it('writeGlobalConfig does not leave stale temp files in the config dir', async () => {
        const { writeGlobalConfig } = await loadActions();
        writeGlobalConfig({ contents: '{}' });
        const parent = path.dirname(configPath);
        const leftovers = fs
            .readdirSync(parent)
            .filter((name) => name.startsWith('config.json.tmp-'));
        expect(leftovers).toEqual([]);
    });

    it('openGlobalConfig seeds the file with {} when missing', async () => {
        const { openGlobalConfig } = await loadActions();
        openGlobalConfig();
        // Seeded synchronously before shell.openPath is invoked.
        expect(fs.existsSync(configPath)).toBe(true);
        expect(fs.readFileSync(configPath, 'utf-8').trim()).toBe('{}');
    });

    it('openGlobalConfig does not overwrite an existing file', async () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{"keepme":1}', 'utf-8');
        const { openGlobalConfig } = await loadActions();
        openGlobalConfig();
        expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"keepme":1}');
    });
});
