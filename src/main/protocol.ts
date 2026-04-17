// ============================================================
// Protocol types — IPC message payloads & JSON-RPC params
// ============================================================

import { EcaServerStatus } from './server';

// ── Shared ──

export interface WorkspaceFolder {
    name: string;
    uri: string;
}

export interface ChatEntry {
    id: string;
    title: string;
    status: string;
    workspaceFolderName: string;
    /**
     * Epoch millis the chat was last touched. Populated from the server on
     * `chat/list` and refreshed locally on `chat/opened` or when an entry is
     * first created in the current session. Optional because very old call
     * sites may still omit it.
     */
    updatedAt?: number;
}

export interface ChatListUpdate {
    entries: ChatEntry[];
    selectedId: string | null;
    activeWorkspaceFolderName: string;
}

// ── JSON-RPC Initialize ──

export interface InitializeParams {
    processId: number;
    clientInfo: { name: string; version: string };
    capabilities: {
        codeAssistant: {
            chat: boolean;
            chatCapabilities?: { askQuestion?: boolean };
        };
    };
    workspaceFolders: WorkspaceFolder[];
}

export interface InitializeResult {
    [key: string]: unknown;
}

// ── Chat RPC Params ──

export interface ChatPromptParams {
    chatId?: string;
    message: string;
    model?: string;
    agent?: string;
    variant?: string;
    trust?: string;
    requestId?: string;
    contexts?: unknown[];
}

export interface ChatPromptResult {
    chatId: string;
}

export interface ChatDeleteParams {
    chatId: string;
}

export interface ChatIdParams {
    chatId: string;
}

export interface ChatRollbackParams {
    chatId: string;
    [key: string]: unknown;
}

export interface ChatFlagParams {
    chatId: string;
    [key: string]: unknown;
}

export interface ChatForkParams {
    chatId: string;
    [key: string]: unknown;
}

export interface ChatUpdateParams {
    chatId: string;
    [key: string]: unknown;
}

export interface ChatListParams {
    /** Optional upper bound on the number of chats returned. */
    limit?: number;
    /** Sort key; server default is "updatedAt" when omitted. */
    sortBy?: 'updatedAt' | 'createdAt';
}

export interface ChatSummary {
    id: string;
    title?: string;
    status: string;
    createdAt?: number;
    updatedAt?: number;
    model?: string;
    messageCount: number;
}

export interface ChatListResponse {
    chats: ChatSummary[];
}

export interface ChatOpenParams {
    chatId: string;
}

export interface ChatOpenResponse {
    /** True when the chat was replayed (chat/cleared + chat/opened + content). */
    found: boolean;
    chatId?: string;
    title?: string;
}

export interface QueryContextParams {
    requestId?: string;
    [key: string]: unknown;
}

export interface QueryContextResult {
    contexts: unknown[];
    requestId?: string;
}

export interface QueryCommandsParams {
    requestId?: string;
    [key: string]: unknown;
}

export interface QueryCommandsResult {
    commands: unknown[];
    requestId?: string;
}

export interface QueryFilesParams {
    requestId?: string;
    [key: string]: unknown;
}

export interface QueryFilesResult {
    files: unknown[];
    requestId?: string;
}

// ── Chat Notifications ──

export interface ChatContentReceivedParams {
    chatId: string;
    parentChatId?: string;
    [key: string]: unknown;
}

export interface ChatClearedParams {
    chatId: string;
    messages?: unknown;
    [key: string]: unknown;
}

export interface ChatDeletedParams {
    chatId: string;
}

export interface ChatOpenedParams {
    chatId: string;
    title?: string;
    status?: string;
    parentChatId?: string;
    [key: string]: unknown;
}

export interface ChatStatusChangedParams {
    chatId: string;
    status: string;
    [key: string]: unknown;
}

export interface ChatToolCallParams {
    chatId: string;
    [key: string]: unknown;
}

export interface ChatPromptStopParams {
    chatId: string;
}

export interface ChatSteerParams {
    chatId: string;
    [key: string]: unknown;
}

export interface ChatModelChangedParams {
    chatId: string;
    [key: string]: unknown;
}

export interface ChatAgentChangedParams {
    chatId: string;
    [key: string]: unknown;
}

// ── Chat Ask Question (server → client request) ──

export interface AskQuestionOption {
    label: string;
    description?: string;
}

export interface AskQuestionParams {
    chatId: string;
    question: string;
    options: AskQuestionOption[];
    toolCallId?: string;
    allowFreeform?: boolean;
}

export interface AskQuestionResult {
    answer: string | null;
    cancelled: boolean;
}

// ── MCP ──

export interface McpServerNameParams {
    name: string;
}

export interface McpUpdateServerParams {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    requestId?: string;
}

export interface McpUpdateServerResult {
    requestId?: string;
    [key: string]: unknown;
}

/**
 * Payload for `mcp/addServer` (JSON-RPC request).
 *
 * Exactly one of stdio (`command` + optional `args`/`env`) or HTTP
 * (`url` + optional `headers`) must be supplied. `scope` defaults to
 * "global" on the server; "workspace" requires `workspaceUri`.
 */
export interface McpAddServerParams {
    name: string;
    // stdio transport
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    // HTTP transport
    url?: string;
    headers?: Record<string, string>;
    clientId?: string;
    clientSecret?: string;
    oauthPort?: number;
    // shared
    disabled?: boolean;
    scope?: 'global' | 'workspace';
    workspaceUri?: string;
    requestId?: string;
}

export interface McpAddServerResult {
    requestId?: string;
    server?: ToolServerUpdatedParams;
    error?: { code: string; message: string; data?: unknown };
    [key: string]: unknown;
}

export interface McpRemoveServerParams {
    name: string;
    requestId?: string;
}

export interface McpRemoveServerResult {
    requestId?: string;
    name?: string;
    removed?: boolean;
    error?: { code: string; message: string; data?: unknown };
    [key: string]: unknown;
}

// ── Tool Servers ──

export interface ToolServerUpdatedParams {
    name: string;
    [key: string]: unknown;
}

export interface ToolServerRemovedParams {
    name: string;
}

// ── Config ──

export interface ConfigUpdatedParams {
    [key: string]: unknown;
}

// ── Providers ──

export interface ProvidersRequestParams {
    requestId?: string;
    [key: string]: unknown;
}

export interface ProvidersResult {
    requestId?: string;
    [key: string]: unknown;
}

// ── Background Jobs ──

export interface JobsListParams {
    requestId?: string;
}

export interface JobsReadOutputParams {
    jobId: string;
    requestId?: string;
}

export interface JobsKillParams {
    jobId: string;
    requestId?: string;
}

export interface JobsResult {
    requestId?: string;
    [key: string]: unknown;
}

// ── Editor Actions (desktop-only, not RPC) ──

export interface EditorOpenFileData {
    path: string;
}

export interface EditorOpenUrlData {
    url: string;
}

export interface EditorSaveFileData {
    defaultName?: string;
    content: string;
}

export interface EditorSaveClipboardImageData {
    base64Data: string;
    mimeType: string;
    requestId: string;
}

export interface EditorSaveClipboardImageResult {
    requestId: string;
    path: string;
}

// ── Editor: ECA global config ──

export interface EditorReadGlobalConfigParams {
    requestId?: string;
}

export interface EditorReadGlobalConfigResult {
    requestId?: string;
    /** Raw file contents. Empty string when the file does not yet exist. */
    contents: string;
    /** Absolute path resolved on the main side (see getGlobalConfigPath). */
    path: string;
    /** Whether the file exists on disk at read time. */
    exists: boolean;
    /** Populated when reading succeeded structurally but an error was caught. */
    error?: string;
}

export interface EditorWriteGlobalConfigData {
    contents: string;
    requestId?: string;
}

export interface EditorWriteGlobalConfigResult {
    requestId?: string;
    ok: boolean;
    /** Absolute path written to when ok === true. */
    path?: string;
    /** Populated on validation or IO failure. Contents are untouched on disk. */
    error?: string;
}

// ── Session Management ──

export interface SessionInfo {
    id: string;
    workspaceFolder: WorkspaceFolder;
    status: string;
}

export interface SessionListUpdate {
    sessions: SessionInfo[];
    activeSessionId: string | null;
}

export interface RecentWorkspace {
    uri: string;
    name: string;
    lastOpened: number;
}

export interface WelcomeData {
    recentWorkspaces: RecentWorkspace[];
}

// ── IPC Message (renderer -> main) ──

export type IpcMessageType =
    | 'webview/ready'
    | 'chat/userPrompt'
    | 'chat/queryContext'
    | 'chat/queryCommands'
    | 'chat/queryFiles'
    | 'chat/delete'
    | 'chat/rollback'
    | 'chat/addFlag'
    | 'chat/removeFlag'
    | 'chat/fork'
    | 'chat/update'
    | 'chat/toolCallApprove'
    | 'chat/toolCallReject'
    | 'chat/promptStop'
    | 'chat/promptSteer'
    | 'chat/selectedModelChanged'
    | 'chat/selectedAgentChanged'
    | 'chat/answerQuestion'
    | 'mcp/startServer'
    | 'mcp/stopServer'
    | 'mcp/connectServer'
    | 'mcp/logoutServer'
    | 'mcp/disableServer'
    | 'mcp/enableServer'
    | 'mcp/updateServer'
    | 'mcp/addServer'
    | 'mcp/removeServer'
    | 'providers/list'
    | 'providers/login'
    | 'providers/loginInput'
    | 'providers/logout'
    | 'jobs/list'
    | 'jobs/readOutput'
    | 'jobs/kill'
    | 'editor/openFile'
    | 'editor/openUrl'
    | 'editor/saveFile'
    | 'editor/saveClipboardImage'
    | 'editor/toggleSidebar'
    | 'editor/openGlobalConfig'
    | 'editor/readGlobalConfig'
    | 'editor/writeGlobalConfig';

export interface IpcMessage {
    type: IpcMessageType;
    data: Record<string, unknown>;
}
