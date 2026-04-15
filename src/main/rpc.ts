import * as rpc from 'vscode-jsonrpc/node';

// Lifecycle
export const initialize = new rpc.RequestType<any, any, void>('initialize');
export const initialized = new rpc.NotificationType<any>('initialized');
export const shutdown = new rpc.RequestType<any, void, void>('shutdown');
export const exit = new rpc.NotificationType<any>('exit');

// Chat - Requests
export const chatPrompt = new rpc.RequestType<any, any, void>('chat/prompt');
export const chatDelete = new rpc.RequestType<any, any, void>('chat/delete');
export const chatRollback = new rpc.RequestType<any, any, void>('chat/rollback');
export const chatAddFlag = new rpc.RequestType<any, any, void>('chat/addFlag');
export const chatRemoveFlag = new rpc.RequestType<any, any, void>('chat/removeFlag');
export const chatFork = new rpc.RequestType<any, any, void>('chat/fork');
export const chatUpdate = new rpc.RequestType<any, any, void>('chat/update');
export const chatQueryContext = new rpc.RequestType<any, any, void>('chat/queryContext');
export const chatQueryCommands = new rpc.RequestType<any, any, void>('chat/queryCommands');
export const chatQueryFiles = new rpc.RequestType<any, any, void>('chat/queryFiles');

// Chat - Notifications (server -> client)
export const chatContentReceived = new rpc.NotificationType<any>('chat/contentReceived');
export const chatCleared = new rpc.NotificationType<any>('chat/cleared');
export const chatDeleted = new rpc.NotificationType<any>('chat/deleted');
export const chatOpened = new rpc.NotificationType<any>('chat/opened');
export const chatStatusChanged = new rpc.NotificationType<any>('chat/statusChanged');

// Chat - Notifications (client -> server)
export const chatToolCallApprove = new rpc.NotificationType<any>('chat/toolCallApprove');
export const chatToolCallReject = new rpc.NotificationType<any>('chat/toolCallReject');
export const chatPromptStop = new rpc.NotificationType<any>('chat/promptStop');
export const chatPromptSteer = new rpc.NotificationType<any>('chat/promptSteer');
export const chatSelectedModelChanged = new rpc.NotificationType<any>('chat/selectedModelChanged');
export const chatSelectedAgentChanged = new rpc.NotificationType<any>('chat/selectedAgentChanged');

// MCP
export const mcpStartServer = new rpc.NotificationType<any>('mcp/startServer');
export const mcpStopServer = new rpc.NotificationType<any>('mcp/stopServer');
export const mcpConnectServer = new rpc.NotificationType<any>('mcp/connectServer');
export const mcpLogoutServer = new rpc.NotificationType<any>('mcp/logoutServer');
export const mcpDisableServer = new rpc.NotificationType<any>('mcp/disableServer');
export const mcpEnableServer = new rpc.NotificationType<any>('mcp/enableServer');
export const mcpUpdateServer = new rpc.RequestType<any, any, void>('mcp/updateServer');

// Tool servers
export const toolServerUpdated = new rpc.NotificationType<any>('tool/serverUpdated');

// Config
export const configUpdated = new rpc.NotificationType<any>('config/updated');

// Providers
export const providersList = new rpc.RequestType<any, any, void>('providers/list');
export const providersLogin = new rpc.RequestType<any, any, void>('providers/login');
export const providersLoginInput = new rpc.RequestType<any, any, void>('providers/loginInput');
export const providersLogout = new rpc.RequestType<any, any, void>('providers/logout');
export const providersUpdated = new rpc.NotificationType<any>('providers/updated');

// Background Jobs
export const jobsUpdated = new rpc.NotificationType<any>('jobs/updated');
export const jobsList = new rpc.RequestType<any, any, void>('jobs/list');
export const jobsReadOutput = new rpc.RequestType<any, any, void>('jobs/readOutput');
export const jobsKill = new rpc.RequestType<any, any, void>('jobs/kill');
