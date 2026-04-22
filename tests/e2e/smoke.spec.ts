// ---------------------------------------------------------------------------
// Minimal Electron smoke test for ECA Desktop.
//
// Requires `@playwright/test` to be installed (see playwright.config.ts).
// Also requires a prior `npm run build` so that `dist/main.js` exists.
// ---------------------------------------------------------------------------

import { test, expect, _electron as electron } from '@playwright/test';
import * as path from 'path';

test('app launches and main window has a title', async () => {
    // Launch the built Electron app.
    const electronApp = await electron.launch({
        args: [path.join(__dirname, '..', '..', 'dist', 'main.js')],
        env: {
            ...process.env,
            // Ensure Electron doesn't run as a plain Node process.
            ELECTRON_RUN_AS_NODE: '',
            // Disable auto-updates or any network side-effects during smoke tests.
            ECA_E2E: '1',
        },
    });

    // Wait for the first BrowserWindow to open.
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const title = await window.title();
    // Accept anything non-empty; prefer that it mentions "ECA".
    expect(title).toBeTruthy();
    expect(title.length).toBeGreaterThan(0);
    // Soft check — don't fail the smoke test if the product name changes.
    if (!/ECA/i.test(title)) {
        // eslint-disable-next-line no-console
        console.warn(`[smoke] window title did not contain "ECA": ${title}`);
    }

    await electronApp.close();
});
