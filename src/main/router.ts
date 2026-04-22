// ============================================================
// Message router — data-driven dispatch replacing the switch
// ============================================================

import type { BrowserWindow } from 'electron';
import type * as rpc from 'vscode-jsonrpc/node';
import * as rpcTypes from './rpc';
import type { ChatState } from './chat-state';
import * as editorActions from './editor-actions';
import type { IpcMessage, WorkspaceFolder, McpAddServerParams } from './protocol';

type SendFn = (type: string, data: unknown) => void;

interface RouteContext {
    conn: rpc.MessageConnection;
    sendToRenderer: SendFn;
    mainWindow: BrowserWindow;
    chatState: ChatState;
    workspaceFolders: WorkspaceFolder[];
}

// Route handlers receive the raw webview IPC payload as a string-indexed
// bag. Using `any` for the values here is deliberate: the router is a
// dynamic dispatch layer over many heterogeneous message shapes, and
// narrowing per-field would require bespoke types per route (a much
// bigger refactor than this file warrants). Individual handlers cast
// each field to the shape they expect.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (ctx: RouteContext, data: Record<string, any>) => Promise<void> | void;

// ── Route table ──

const routes: Record<string, RouteHandler> = {

    // ── Lifecycle ──

    'webview/ready': (_ctx) => {
        // No-op: rehydration is handled by did-finish-load in bridge
    },

    // ── Chat Requests ──

    'chat/userPrompt': async (ctx, data) => {
        const isNewChat = !data.chatId;
        const promptText = (data.prompt as string) || '';
        const result = await ctx.conn.sendRequest(rpcTypes.chatPrompt, {
            chatId: data.chatId,
            message: data.prompt,
            model: data.model,
            agent: data.agent,
            variant: data.variant,
            trust: data.trust,
            requestId: data.requestId?.toString(),
            contexts: data.contexts,
        });
        ctx.sendToRenderer('chat/newChat', { id: result.chatId });

        if (isNewChat && result.chatId) {
            // Replace the pending "New Chat" placeholder with the real entry
            ctx.chatState.removePendingChat();
            const title = promptText.length > 50
                ? promptText.substring(0, 50) + '…'
                : (promptText || 'New Chat');
            ctx.chatState.addOrUpdateEntry(result.chatId, { title, status: 'generating' });
        }
        if (result.chatId) {
            ctx.chatState.selectedChatId = result.chatId;
        }
    },

    'chat/queryContext': async (ctx, data) => {
        try {
            const result = await ctx.conn.sendRequest(rpcTypes.chatQueryContext, data);
            ctx.sendToRenderer('chat/queryContext', result);
        } catch (err) {
            console.warn('[Router] chat/queryContext failed, returning empty:', err);
            ctx.sendToRenderer('chat/queryContext', { contexts: [], requestId: data.requestId });
        }
    },

    'chat/queryCommands': async (ctx, data) => {
        try {
            const result = await ctx.conn.sendRequest(rpcTypes.chatQueryCommands, data);
            ctx.sendToRenderer('chat/queryCommands', result);
        } catch (err) {
            console.warn('[Router] chat/queryCommands failed, returning empty:', err);
            ctx.sendToRenderer('chat/queryCommands', { commands: [], requestId: data.requestId });
        }
    },

    'chat/queryFiles': async (ctx, data) => {
        try {
            const result = await ctx.conn.sendRequest(rpcTypes.chatQueryFiles, data);
            ctx.sendToRenderer('chat/queryFiles', result);
        } catch (err) {
            console.warn('[Router] chat/queryFiles failed, returning empty:', err);
            ctx.sendToRenderer('chat/queryFiles', { files: [], requestId: data.requestId });
        }
    },

    'chat/delete': async (ctx, data) => {
        await ctx.conn.sendRequest(rpcTypes.chatDelete, { chatId: data.chatId });
    },

    'chat/rollback': async (ctx, data) => {
        await ctx.conn.sendRequest(rpcTypes.chatRollback, data);
    },

    'chat/addFlag': async (ctx, data) => {
        await ctx.conn.sendRequest(rpcTypes.chatAddFlag, data);
    },

    'chat/removeFlag': async (ctx, data) => {
        await ctx.conn.sendRequest(rpcTypes.chatRemoveFlag, data);
    },

    'chat/fork': async (ctx, data) => {
        await ctx.conn.sendRequest(rpcTypes.chatFork, data);
    },

    'chat/update': async (ctx, data) => {
        await ctx.conn.sendRequest(rpcTypes.chatUpdate, data);
    },

    // ── Chat Notifications (fire-and-forget) ──

    'chat/toolCallApprove': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.chatToolCallApprove, data);
    },

    'chat/toolCallReject': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.chatToolCallReject, data);
    },

    'chat/promptStop': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.chatPromptStop, { chatId: data.chatId });
    },

    'chat/promptSteer': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.chatPromptSteer, data);
    },

    'chat/selectedModelChanged': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.chatSelectedModelChanged, data);
    },

    'chat/selectedAgentChanged': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.chatSelectedAgentChanged, data);
    },

    // ── MCP ──

    'mcp/startServer': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.mcpStartServer, { name: data.name });
    },

    'mcp/stopServer': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.mcpStopServer, { name: data.name });
    },

    'mcp/connectServer': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.mcpConnectServer, { name: data.name });
    },

    'mcp/logoutServer': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.mcpLogoutServer, { name: data.name });
    },

    'mcp/disableServer': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.mcpDisableServer, { name: data.name });
    },

    'mcp/enableServer': (ctx, data) => {
        ctx.conn.sendNotification(rpcTypes.mcpEnableServer, { name: data.name });
    },

    'mcp/updateServer': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.mcpUpdateServer, {
            name: data.name,
            ...(data.command !== undefined && { command: data.command }),
            ...(data.args !== undefined && { args: data.args }),
            ...(data.url !== undefined && { url: data.url }),
            ...(data.env !== undefined && { env: data.env }),
            ...(data.headers !== undefined && { headers: data.headers }),
        });
        ctx.sendToRenderer('mcp/updateServer', { requestId: data.requestId, ...result });
    },

    'mcp/addServer': async (ctx, data) => {
        const params: Record<string, unknown> = { name: data.name };
        // Forward only fields the caller provided; the server accepts a
        // stdio/HTTP union and enforces exclusivity.
        for (const k of ['command', 'args', 'env', 'url', 'headers',
                          'clientId', 'clientSecret', 'oauthPort',
                          'disabled', 'scope', 'workspaceUri'] as const) {
            if (data[k] !== undefined) params[k] = data[k];
        }
        try {
            // Assembled above to match the McpAddServerParams shape. TS
            // can't prove the union-of-transports invariant structurally,
            // so we go through `unknown` rather than direct-cast from
            // Record<string, unknown>.
            const result = await ctx.conn.sendRequest(
                rpcTypes.mcpAddServer,
                params as unknown as McpAddServerParams,
            );
            ctx.sendToRenderer('mcp/addServer', { requestId: data.requestId, ...result });
        } catch (err) {
            ctx.sendToRenderer('mcp/addServer', {
                requestId: data.requestId,
                error: { code: 'rpc_error', message: (err as Error).message ?? 'Unknown error' },
            });
        }
    },

    'mcp/removeServer': async (ctx, data) => {
        try {
            const result = await ctx.conn.sendRequest(rpcTypes.mcpRemoveServer, { name: data.name });
            ctx.sendToRenderer('mcp/removeServer', { requestId: data.requestId, ...result });
        } catch (err) {
            ctx.sendToRenderer('mcp/removeServer', {
                requestId: data.requestId,
                error: { code: 'rpc_error', message: (err as Error).message ?? 'Unknown error' },
            });
        }
    },

    // ── Providers ──

    'providers/list': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.providersList, data);
        ctx.sendToRenderer('providers/list', { ...result, requestId: data.requestId });
    },

    'providers/login': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.providersLogin, data);
        ctx.sendToRenderer('providers/login', { ...result, requestId: data.requestId });
    },

    'providers/loginInput': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.providersLoginInput, data);
        ctx.sendToRenderer('providers/loginInput', { ...result, requestId: data.requestId });
    },

    'providers/logout': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.providersLogout, data);
        ctx.sendToRenderer('providers/logout', { ...result, requestId: data.requestId });
    },

    // ── Background Jobs ──

    'jobs/list': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.jobsList, {});
        ctx.sendToRenderer('jobs/list', { ...result, requestId: data.requestId });
    },

    'jobs/readOutput': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.jobsReadOutput, { jobId: data.jobId });
        ctx.sendToRenderer('jobs/readOutput', { ...result, requestId: data.requestId });
    },

    'jobs/kill': async (ctx, data) => {
        const result = await ctx.conn.sendRequest(rpcTypes.jobsKill, { jobId: data.jobId });
        ctx.sendToRenderer('jobs/kill', { ...result, requestId: data.requestId });
    },

    // ── Editor actions (desktop-only, not routed to server) ──

    'editor/openFile': (ctx, data) => {
        // Feed the active workspace roots to the openFile scope check so
        // a compromised renderer can't use `shell.openPath` to launch
        // arbitrary executables outside the user's project. Roots come
        // as file:// URIs; convert each to a filesystem path.
        const roots = ctx.workspaceFolders
            .map((f) => {
                try { return new URL(f.uri).pathname; }
                catch { return null; }
            })
            .filter((p): p is string => p !== null);
        editorActions.openFile({ path: data.path as string }, roots);
    },

    'editor/openUrl': (_ctx, data) => {
        editorActions.openUrl({ url: data.url as string });
    },

    'editor/saveFile': async (ctx, data) => {
        await editorActions.saveFile(ctx.mainWindow, {
            content: data.content as string,
            defaultName: data.defaultName as string | undefined,
        });
    },

    'editor/saveClipboardImage': (ctx, data) => {
        const result = editorActions.saveClipboardImage({
            base64Data: data.base64Data as string,
            mimeType: data.mimeType as string,
            requestId: data.requestId as string,
        });
        if (result) {
            ctx.sendToRenderer('editor/saveClipboardImage', result);
        }
    },

    'editor/toggleSidebar': (ctx) => {
        if (!ctx.mainWindow.isDestroyed()) {
            ctx.mainWindow.webContents.send('sidebar-toggle');
        }
    },

    'editor/openGlobalConfig': () => {
        editorActions.openGlobalConfig();
    },

    'editor/readGlobalConfig': (ctx, data) => {
        const result = editorActions.readGlobalConfig();
        ctx.sendToRenderer('editor/readGlobalConfig', {
            ...result,
            requestId: data.requestId,
        });
    },

    'editor/writeGlobalConfig': (ctx, data) => {
        const result = editorActions.writeGlobalConfig({
            contents: (data.contents as string) ?? '',
        });
        ctx.sendToRenderer('editor/writeGlobalConfig', {
            ...result,
            requestId: data.requestId,
        });
    },
};

// ── Public API ──

/**
 * Dispatches an IPC message to the appropriate handler.
 * Returns false if no handler was found, true otherwise.
 */
export async function dispatch(ctx: RouteContext, message: IpcMessage): Promise<boolean> {
    const handler = routes[message.type];
    if (!handler) {
        console.warn('[Router] Unhandled message type:', message.type);
        return false;
    }

    await handler(ctx, message.data || {});
    return true;
}

export type { RouteContext };
