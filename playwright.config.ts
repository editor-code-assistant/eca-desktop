// ---------------------------------------------------------------------------
// Playwright configuration for ECA Desktop end-to-end (Electron) tests.
//
// NOTE: This is scaffolding. To actually run these tests you must install the
// Playwright test runner as a devDependency:
//
//     npm install --save-dev @playwright/test
//
// It has deliberately NOT been added to package.json dependencies — the
// maintainer will decide when/whether to bring it in.
//
// Once installed:
//   1. Run `npm run build` first so `dist/main.js` exists.
//   2. Run `npm run test:e2e`.
// ---------------------------------------------------------------------------

import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 30_000,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'electron',
            // The actual Electron entry point (dist/main.js) is launched
            // programmatically inside each spec via `_electron.launch`.
            testMatch: /.*\.spec\.ts/,
        },
    ],
});
