// Invoked by the npm `version` lifecycle hook (see package.json): keeps
// the appstream metainfo's <releases> list in sync with package.json so
// Flatpak/Flathub builds always carry correct release info without
// manual edits. npm runs this after bumping the version but before the
// release commit, and the hook git-adds the file so it lands in that
// same commit.
'use strict';

const fs = require('fs');
const path = require('path');

const version = process.env.npm_package_version || require('../package.json').version;
const file = path.join(__dirname, '..', 'build', 'dev.eca.desktop.metainfo.xml');

const xml = fs.readFileSync(file, 'utf8');
if (xml.includes(`<release version="${version}"`)) {
    console.log(`metainfo: release ${version} already present`);
    process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
// Line-anchored so it can only match the actual element, never prose in
// the header comment.
const updated = xml.replace(
    /^(\s*)<releases>/m,
    (_m, indent) => `${indent}<releases>\n${indent}  <release version="${version}" date="${date}"/>`,
);
if (updated === xml) {
    console.error('metainfo: <releases> block not found');
    process.exit(1);
}

fs.writeFileSync(file, updated);
console.log(`metainfo: added release ${version} (${date})`);
