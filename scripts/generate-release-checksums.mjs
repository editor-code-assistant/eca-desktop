import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_PATTERN = /\.(?:AppImage|deb|dmg|exe|zip)$/i;
const BLOCKMAP_PATTERN = /\.blockmap$/i;
const UPDATER_METADATA_PATTERN = /^latest(?:-[a-z]+)?\.yml$/i;
const LABEL_PATTERN = /^[a-z0-9-]+$/;

export function isReleaseFile(fileName) {
    return PACKAGE_PATTERN.test(fileName)
        || BLOCKMAP_PATTERN.test(fileName)
        || UPDATER_METADATA_PATTERN.test(fileName);
}

export async function sha256File(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

export async function generateReleaseChecksums(releaseDirectory, platformLabel) {
    if (!LABEL_PATTERN.test(platformLabel)) {
        throw new Error(`Invalid platform label: ${platformLabel}`);
    }

    const absoluteDirectory = path.resolve(releaseDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const fileNames = entries
        .filter((entry) => entry.isFile() && isReleaseFile(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'));

    if (!fileNames.some((fileName) => PACKAGE_PATTERN.test(fileName))) {
        throw new Error(`No release packages found in ${absoluteDirectory}.`);
    }

    const lines = [];
    for (const fileName of fileNames) {
        const digest = await sha256File(path.join(absoluteDirectory, fileName));
        lines.push(`${digest}  ${fileName}`);
    }

    const outputPath = path.join(absoluteDirectory, `SHA256SUMS-${platformLabel}.txt`);
    await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
    return { outputPath, fileNames };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
    const [, , releaseDirectory, platformLabel] = process.argv;
    if (!releaseDirectory || !platformLabel) {
        throw new Error('Usage: node scripts/generate-release-checksums.mjs <release-directory> <platform-label>');
    }
    const result = await generateReleaseChecksums(releaseDirectory, platformLabel);
    console.log(`Wrote ${result.outputPath} for ${result.fileNames.length} release files.`);
}
