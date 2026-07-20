import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 30_000,
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'electron',
            testMatch: /.*\.spec\.ts/,
        },
    ],
});
