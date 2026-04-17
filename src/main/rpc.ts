import * as rpc from 'vscode-jsonrpc/node';
import {
    ChatPromptParams, ChatPromptResult,
    ChatDeleteParams,
    ChatRollbackParams,
    ChatFlagParams,
    ChatForkParams,
    ChatUpdateParams,
    ChatListParams, ChatListResponse,
    ChatOpenParams, ChatOpenResponse,
    QueryContextParams, QueryContextResult,
    QueryCommandsParams, QueryCommandsResult,
    QueryFilesParams, QueryFilesResult,
    ChatContentReceivedParams,
    ChatClearedParams,
    ChatDeletedParams,
    ChatOpenedParams,
    ChatStatusChangedParams,
    ChatToolCallParams,
    ChatPromptStopParams,
    ChatSteerParams,
    ChatModelChangedParams,
    ChatAgentChangedParams,
    AskQuestionParams, AskQuestionResult,
    McpServerNameParams,
    McpUpdateServerParams, McpUpdateServerResult,
    McpAddServerParams, McpAddServerResult,
    McpRemoveServerParams, McpRemoveServerResult,
    ToolServerUpdatedParams,
    ToolServerRemovedParams,
    ConfigUpdatedParams,
    ProvidersRequestParams, ProvidersResult,
    JobsListParams, JobsResult,
    JobsReadOutputParams,
    JobsKillParams,
    InitializeParams, InitializeResult,
} from './protocol';

// ── Lifecycle ──

export const initialize = new rpc.RequestType<InitializeParams, InitializeResult, void>('initialize');
export const initialized = new rpc.NotificationType<Record<string, never>>('initialized');
export const shutdown = new rpc.RequestType<void, void, void>('shutdown');
export const exit = new rpc.NotificationType<void>('exit');

// ── Chat — Requests ──

export const chatPrompt = new rpc.RequestType<ChatPromptParams, ChatPromptResult, void>('chat/prompt');
export const chatDelete = new rpc.RequestType<ChatDeleteParams, void, void>('chat/delete');
export const chatRollback = new rpc.RequestType<ChatRollbackParams, void, void>('chat/rollback');
export const chatAddFlag = new rpc.RequestType<ChatFlagParams, void, void>('chat/addFlag');
export const chatRemoveFlag = new rpc.RequestType<ChatFlagParams, void, void>('chat/removeFlag');
export const chatFork = new rpc.RequestType<ChatForkParams, void, void>('chat/fork');
export const chatUpdate = new rpc.RequestType<ChatUpdateParams, void, void>('chat/update');
export const chatList = new rpc.RequestType<ChatListParams, ChatListResponse, void>('chat/list');
export const chatOpen = new rpc.RequestType<ChatOpenParams, ChatOpenResponse, void>('chat/open');
export const chatQueryContext = new rpc.RequestType<QueryContextParams, QueryContextResult, void>('chat/queryContext');
export const chatQueryCommands = new rpc.RequestType<QueryCommandsParams, QueryCommandsResult, void>('chat/queryCommands');
export const chatQueryFiles = new rpc.RequestType<QueryFilesParams, QueryFilesResult, void>('chat/queryFiles');

// ── Chat — Notifications (server → client) ──

export const chatContentReceived = new rpc.NotificationType<ChatContentReceivedParams>('chat/contentReceived');
export const chatCleared = new rpc.NotificationType<ChatClearedParams>('chat/cleared');
export const chatDeleted = new rpc.NotificationType<ChatDeletedParams>('chat/deleted');
export const chatOpened = new rpc.NotificationType<ChatOpenedParams>('chat/opened');
export const chatStatusChanged = new rpc.NotificationType<ChatStatusChangedParams>('chat/statusChanged');

// ── Chat — Notifications (client → server) ──

export const chatToolCallApprove = new rpc.NotificationType<ChatToolCallParams>('chat/toolCallApprove');
export const chatToolCallReject = new rpc.NotificationType<ChatToolCallParams>('chat/toolCallReject');
export const chatPromptStop = new rpc.NotificationType<ChatPromptStopParams>('chat/promptStop');
export const chatPromptSteer = new rpc.NotificationType<ChatSteerParams>('chat/promptSteer');
export const chatSelectedModelChanged = new rpc.NotificationType<ChatModelChangedParams>('chat/selectedModelChanged');
export const chatSelectedAgentChanged = new rpc.NotificationType<ChatAgentChangedParams>('chat/selectedAgentChanged');

// ── Chat — Requests (server → client) ──

export const chatAskQuestion = new rpc.RequestType<AskQuestionParams, AskQuestionResult, void>('chat/askQuestion');

// ── MCP ──

export const mcpStartServer = new rpc.NotificationType<McpServerNameParams>('mcp/startServer');
export const mcpStopServer = new rpc.NotificationType<McpServerNameParams>('mcp/stopServer');
export const mcpConnectServer = new rpc.NotificationType<McpServerNameParams>('mcp/connectServer');
export const mcpLogoutServer = new rpc.NotificationType<McpServerNameParams>('mcp/logoutServer');
export const mcpDisableServer = new rpc.NotificationType<McpServerNameParams>('mcp/disableServer');
export const mcpEnableServer = new rpc.NotificationType<McpServerNameParams>('mcp/enableServer');
export const mcpUpdateServer = new rpc.RequestType<McpUpdateServerParams, McpUpdateServerResult, void>('mcp/updateServer');
export const mcpAddServer = new rpc.RequestType<McpAddServerParams, McpAddServerResult, void>('mcp/addServer');
export const mcpRemoveServer = new rpc.RequestType<McpRemoveServerParams, McpRemoveServerResult, void>('mcp/removeServer');

// ── Tool Servers ──

export const toolServerUpdated = new rpc.NotificationType<ToolServerUpdatedParams>('tool/serverUpdated');
export const toolServerRemoved = new rpc.NotificationType<ToolServerRemovedParams>('tool/serverRemoved');

// ── Config ──

export const configUpdated = new rpc.NotificationType<ConfigUpdatedParams>('config/updated');

// ── Providers ──

export const providersList = new rpc.RequestType<ProvidersRequestParams, ProvidersResult, void>('providers/list');
export const providersLogin = new rpc.RequestType<ProvidersRequestParams, ProvidersResult, void>('providers/login');
export const providersLoginInput = new rpc.RequestType<ProvidersRequestParams, ProvidersResult, void>('providers/loginInput');
export const providersLogout = new rpc.RequestType<ProvidersRequestParams, ProvidersResult, void>('providers/logout');
export const providersUpdated = new rpc.NotificationType<ProvidersResult>('providers/updated');

// ── Background Jobs ──

export const jobsUpdated = new rpc.NotificationType<JobsResult>('jobs/updated');
export const jobsList = new rpc.RequestType<JobsListParams, JobsResult, void>('jobs/list');
export const jobsReadOutput = new rpc.RequestType<JobsReadOutputParams, JobsResult, void>('jobs/readOutput');
export const jobsKill = new rpc.RequestType<JobsKillParams, JobsResult, void>('jobs/kill');
