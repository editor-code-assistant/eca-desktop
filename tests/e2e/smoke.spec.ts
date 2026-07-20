import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    expect,
    test,
    _electron as electron,
    type ElectronApplication,
    type Page,
} from '@playwright/test';

let electronApp: ElectronApplication;
let mainWindow: Page;
let userDataDirectory: string;
const rendererErrors: string[] = [];

function collectRendererErrors(page: Page): void {
    page.on('pageerror', (error) => { rendererErrors.push(error.message); });
    page.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(message.text());
    });
}

async function invokeMenuItem(id: string): Promise<void> {
    await electronApp.evaluate(({ Menu }, menuItemId) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(menuItemId);
        if (!item) throw new Error(`Menu item not found: ${menuItemId}`);
        item.click();
    }, id);
}

test.beforeAll(async () => {
    userDataDirectory = await mkdtemp(path.join(tmpdir(), 'eca-desktop-e2e-'));
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;

    electronApp = await electron.launch({
        args: [
            path.join(__dirname, '..', '..', 'dist', 'main.js'),
            `--user-data-dir=${userDataDirectory}`,
        ],
        env: {
            ...environment,
            ECA_E2E: '1',
        },
    });
    mainWindow = await electronApp.firstWindow();
    collectRendererErrors(mainWindow);
    await mainWindow.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
    await electronApp?.close();
    if (userDataDirectory) {
        await rm(userDataDirectory, { recursive: true, force: true });
    }
});

test('launches the main shell and renders provider settings', async () => {
    await expect(mainWindow).toHaveTitle('ECA Desktop');
    await expect(mainWindow.locator('.welcome-title')).toContainText(/Editor.*Code.*Assistant/);
    await expect(mainWindow.getByRole('button', { name: 'New Session' })).toBeVisible();

    await invokeMenuItem('open-settings-page');

    await expect(mainWindow.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(mainWindow.locator('#sidebar')).toBeVisible();
    const providersTab = mainWindow.getByRole('button', { name: /Providers/ });
    await providersTab.click();
    await expect(providersTab).toHaveClass(/active/);
    await expect(mainWindow.getByText('Manage AI provider authentication and view available models.')).toBeVisible();
    await expect(mainWindow.locator('.providers-tab')).toBeVisible();

    await mainWindow.locator('.back-button').click();
    await expect(mainWindow.locator('.welcome-title')).toContainText(/Editor.*Code.*Assistant/);
    await expect(mainWindow.getByRole('heading', { name: 'Settings' })).not.toBeVisible();
});

test('opens native preferences with general and server controls', async () => {
    const preferencesWindowPromise = electronApp.waitForEvent('window');
    await invokeMenuItem('preferences');
    const preferencesWindow = await preferencesWindowPromise;
    collectRendererErrors(preferencesWindow);

    await expect(preferencesWindow).toHaveTitle('Preferences');
    await expect(preferencesWindow.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(preferencesWindow.getByLabel('Theme')).toHaveValue(/dark|light/);

    await preferencesWindow.getByText('Server', { exact: true }).click();
    await expect(preferencesWindow.getByLabel('Custom server binary path')).toBeVisible();
    await expect(preferencesWindow.getByRole('button', { name: 'Save' })).toBeVisible();
    await preferencesWindow.close();

    expect(rendererErrors).toEqual([]);
});
