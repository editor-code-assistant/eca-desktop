import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateReleaseChecksums, isReleaseFile } from './generate-release-checksums.mjs';

test('recognizes only publishable package and updater files', () => {
    assert.equal(isReleaseFile('eca-windows-x64.exe'), true);
    assert.equal(isReleaseFile('eca-windows-x64.exe.blockmap'), true);
    assert.equal(isReleaseFile('latest.yml'), true);
    assert.equal(isReleaseFile('latest-mac.yml'), true);
    assert.equal(isReleaseFile('builder-debug.yml'), false);
    assert.equal(isReleaseFile('ECA.exe'), true);
});

test('writes a deterministic manifest for top-level release files', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'eca-release-checksums-'));
    context.after(() => rm(directory, { recursive: true, force: true }));

    const installer = Buffer.from('installer');
    const metadata = Buffer.from('metadata');
    await writeFile(path.join(directory, 'eca-windows-x64.exe'), installer);
    await writeFile(path.join(directory, 'latest.yml'), metadata);
    await writeFile(path.join(directory, 'builder-debug.yml'), 'ignored');
    await mkdir(path.join(directory, 'win-unpacked'));
    await writeFile(path.join(directory, 'win-unpacked', 'ECA.exe'), 'ignored');

    const result = await generateReleaseChecksums(directory, 'windows');

    assert.deepEqual(result.fileNames, ['eca-windows-x64.exe', 'latest.yml']);
    const expected = [
        `${createHash('sha256').update(installer).digest('hex')}  eca-windows-x64.exe`,
        `${createHash('sha256').update(metadata).digest('hex')}  latest.yml`,
        '',
    ].join('\n');
    assert.equal(await readFile(result.outputPath, 'utf8'), expected);
});

test('rejects unsafe labels and directories without release packages', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'eca-release-checksums-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(path.join(directory, 'latest.yml'), 'metadata');

    await assert.rejects(
        generateReleaseChecksums(directory, '../windows'),
        /Invalid platform label/,
    );
    await assert.rejects(
        generateReleaseChecksums(directory, 'windows'),
        /No release packages found/,
    );
});
