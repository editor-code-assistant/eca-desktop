import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMessage } from '../protocol';

// ── Mocks ──
//
// `vi.mock` is hoisted to the top of the file, so any factory-closed-over
// identifier must be declared via `vi.hoisted` to also be available at
// hoist time. Using a regular `const` would crash with a TDZ error.

const editorActionsMock = vi.hoisted(() => ({
    openFile: vi.fn(),
    openUrl: vi.fn(),
    saveFile: vi.fn(async () => {}),
    saveClipboardImage: vi.fn(() => null),
    openGlobalConfig: vi.fn(),
    readGlobalConfig: vi.fn(() => ({ contents: '', path: '/p', exists: false })),
    writeGlobalConfig: vi.fn(() => ({ ok: true, path: '/p' })),
}));
vi.mock('../editor-actions', () => editorActionsMock);

vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
}));

import { dispatch } from '../router';
import type { RouteContext } from '../router';

function makeCtx(overrides: Partial<RouteContext> = {}): {
    ctx: RouteContext;
    conn: {
        sendRequest: ReturnType<typeof vi.fn>;
        sendNotification: ReturnType<typeof vi.fn>;
    };
    sendToRenderer: ReturnType<typeof vi.fn>;
    chatState: {
        removePendingChat: ReturnType<typeof vi.fn>;
        addOrUpdateEntry: ReturnType<typeof vi.fn>;
        selectedChatId: string | null;
    };
    mainWindow: {
        isDestroyed: () => boolean;
        webContents: { send: ReturnType<typeof vi.fn> };
    };
} {
    const conn = {
        sendRequest: vi.fn(),
        sendNotification: vi.fn(),
    };
    const sendToRenderer = vi.fn();
    const chatState = {
        removePendingChat: vi.fn(),
        addOrUpdateEntry: vi.fn(),
        selectedChatId: null as string | null,
    };
    const mainWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
    };
    const ctx = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conn: conn as any,
        sendToRenderer,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mainWindow: mainWindow as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatState: chatState as any,
        workspaceFolders: [{ name: 'demo', uri: 'file:///home/user/demo' }],
        ...overrides,
    } as RouteContext;
    return { ctx, conn, sendToRenderer, chatState, mainWindow };
}

describe('router.dispatch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns false and warns for unknown message types', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { ctx } = makeCtx();
        const msg: IpcMessage = { type: 'nope/invented' as never, data: {} };
        const handled = await dispatch(ctx, msg);
        expect(handled).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('Unhandled message type'),
            'nope/invented',
        );
        warn.mockRestore();
    });

    it('returns true for known message types', async () => {
        const { ctx, conn } = makeCtx();
        conn.sendRequest.mockResolvedValue({ chatId: 'c-1' });
        const handled = await dispatch(ctx, {
            type: 'chat/userPrompt' as never,
            data: { prompt: 'hi' },
        });
        expect(handled).toBe(true);
    });

    describe('chat/userPrompt', () => {
        it('sends chat/prompt request and treats missing chatId as a new chat', async () => {
            const { ctx, conn, sendToRenderer, chatState } = makeCtx();
            conn.sendRequest.mockResolvedValue({ chatId: 'new-chat-1' });

            await dispatch(ctx, {
                type: 'chat/userPrompt' as never,
                data: { prompt: 'Hello world', model: 'm', agent: 'a' },
            });

            expect(conn.sendRequest).toHaveBeenCalledOnce();
            const [method, params] = conn.sendRequest.mock.calls[0];
            // Method is the RequestType wrapper; its method string is on .method
            expect(method?.method ?? method).toBe('chat/prompt');
            expect(params).toMatchObject({
                message: 'Hello world',
                model: 'm',
                agent: 'a',
            });
            expect(sendToRenderer).toHaveBeenCalledWith('chat/newChat', { id: 'new-chat-1' });

            expect(chatState.removePendingChat).toHaveBeenCalledOnce();
            expect(chatState.addOrUpdateEntry).toHaveBeenCalledWith('new-chat-1', {
                title: 'Hello world',
                status: 'generating',
            });
            expect(chatState.selectedChatId).toBe('new-chat-1');
        });

        it('truncates long titles at 50 chars + ellipsis', async () => {
            const { ctx, conn, chatState } = makeCtx();
            conn.sendRequest.mockResolvedValue({ chatId: 'c-2' });

            const long = 'x'.repeat(120);
            await dispatch(ctx, {
                type: 'chat/userPrompt' as never,
                data: { prompt: long },
            });

            const [, partial] = chatState.addOrUpdateEntry.mock.calls[0];
            expect(partial.title).toHaveLength(51); // 50 + ellipsis
            expect(partial.title.endsWith('…')).toBe(true);
        });

        it('does not touch the sidebar when chatId is provided (existing chat)', async () => {
            const { ctx, conn, chatState } = makeCtx();
            conn.sendRequest.mockResolvedValue({ chatId: 'existing' });

            await dispatch(ctx, {
                type: 'chat/userPrompt' as never,
                data: { chatId: 'existing', prompt: 'follow-up' },
            });

            expect(chatState.removePendingChat).not.toHaveBeenCalled();
            expect(chatState.addOrUpdateEntry).not.toHaveBeenCalled();
            expect(chatState.selectedChatId).toBe('existing');
        });
    });

    describe('chat/queryContext', () => {
        it('forwards the server result', async () => {
            const { ctx, conn, sendToRenderer } = makeCtx();
            conn.sendRequest.mockResolvedValue({
                contexts: [{ id: 'x' }],
                requestId: 'r-1',
            });
            await dispatch(ctx, {
                type: 'chat/queryContext' as never,
                data: { query: 'foo', requestId: 'r-1' },
            });
            expect(sendToRenderer).toHaveBeenCalledWith('chat/queryContext', {
                contexts: [{ id: 'x' }],
                requestId: 'r-1',
            });
        });

        it('returns an empty result when the server throws', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const { ctx, conn, sendToRenderer } = makeCtx();
            conn.sendRequest.mockRejectedValue(new Error('boom'));

            await dispatch(ctx, {
                type: 'chat/queryContext' as never,
                data: { requestId: 'r-2' },
            });

            expect(sendToRenderer).toHaveBeenCalledWith('chat/queryContext', {
                contexts: [],
                requestId: 'r-2',
            });
            warn.mockRestore();
        });
    });

    describe('fire-and-forget notifications', () => {
        it('chat/promptStop sends a notification with chatId only', async () => {
            const { ctx, conn } = makeCtx();
            await dispatch(ctx, {
                type: 'chat/promptStop' as never,
                data: { chatId: 'x', extraneous: 1 },
            });
            expect(conn.sendNotification).toHaveBeenCalledOnce();
            const [method, params] = conn.sendNotification.mock.calls[0];
            expect(method?.method ?? method).toBe('chat/promptStop');
            expect(params).toEqual({ chatId: 'x' });
        });

        it('mcp/startServer forwards the name', async () => {
            const { ctx, conn } = makeCtx();
            await dispatch(ctx, {
                type: 'mcp/startServer' as never,
                data: { name: 'my-server', other: 'ignored' },
            });
            const [method, params] = conn.sendNotification.mock.calls[0];
            expect(method?.method ?? method).toBe('mcp/startServer');
            expect(params).toEqual({ name: 'my-server' });
        });
    });

    describe('editor/openFile', () => {
        it('passes workspace-root paths (not URIs) to editorActions.openFile', async () => {
            const { ctx } = makeCtx({
                workspaceFolders: [
                    { name: 'a', uri: 'file:///home/user/a' },
                    { name: 'b', uri: 'file:///home/user/b' },
                ],
            });

            await dispatch(ctx, {
                type: 'editor/openFile' as never,
                data: { path: '/home/user/a/main.ts' },
            });

            expect(editorActionsMock.openFile).toHaveBeenCalledOnce();
            const [payload, roots] = editorActionsMock.openFile.mock.calls[0];
            expect(payload).toEqual({ path: '/home/user/a/main.ts' });
            expect(roots).toEqual(['/home/user/a', '/home/user/b']);
        });

        it('skips malformed URIs silently', async () => {
            const { ctx } = makeCtx({
                workspaceFolders: [
                    { name: 'a', uri: 'not-a-uri' },
                    { name: 'b', uri: 'file:///home/user/b' },
                ],
            });
            await dispatch(ctx, {
                type: 'editor/openFile' as never,
                data: { path: '/home/user/b/x.ts' },
            });
            const [, roots] = editorActionsMock.openFile.mock.calls[0];
            expect(roots).toEqual(['/home/user/b']);
        });
    });

    describe('mcp/addServer', () => {
        it('forwards only provided fields and surfaces error via sendToRenderer', async () => {
            const { ctx, conn, sendToRenderer } = makeCtx();
            conn.sendRequest.mockRejectedValue(new Error('addServer boom'));

            await dispatch(ctx, {
                type: 'mcp/addServer' as never,
                data: {
                    name: 'srv',
                    command: 'node',
                    args: ['x.js'],
                    requestId: 'r-7',
                    // extras that should NOT end up in params:
                    banana: 'nope',
                },
            });

            // One of the sendToRenderer calls should be the error envelope
            const errCall = sendToRenderer.mock.calls.find(
                (c) => c[0] === 'mcp/addServer' && (c[1] as Record<string, unknown>).error,
            );
            expect(errCall).toBeTruthy();
            expect((errCall![1] as Record<string, unknown>).requestId).toBe('r-7');
        });
    });
});
