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
    capabilities: { codeAssistant: { chat: boolean } };
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

// ── MCP ──

export interface McpServerNameParams {
    name: string;
}

export interface McpUpdateServerParams {
    name: string;
    command?: string;
    args?: string[];
    url?: string;
    requestId?: string;
}

export interface McpUpdateServerResult {
    requestId?: string;
    [key: string]: unknown;
}

// ── Tool Servers ──

export interface ToolServerUpdatedParams {
    name: string;
    [key: string]: unknown;
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
    | 'mcp/startServer'
    | 'mcp/stopServer'
    | 'mcp/connectServer'
    | 'mcp/logoutServer'
    | 'mcp/disableServer'
    | 'mcp/enableServer'
    | 'mcp/updateServer'
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
    | 'editor/toggleSidebar';

export interface IpcMessage {
    type: IpcMessageType;
    data: Record<string, unknown>;
}
