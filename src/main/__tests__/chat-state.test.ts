import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatOpenedParams, ChatContentReceivedParams, WorkspaceFolder } from '../protocol';

// Mock electron before importing ChatState
vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
}));

import { ChatState, PENDING_CHAT_ID } from '../chat-state';

function createState(folders = [{ name: 'test-project', uri: '/tmp/test' }]): ChatState {
    return new ChatState(folders);
}

describe('ChatState', () => {
    let state: ChatState;

    beforeEach(() => {
        state = createState();
    });

    describe('entry management', () => {
        it('should add a new entry', () => {
            state.addOrUpdateEntry('chat-1', { title: 'Hello', status: 'idle' });
            const list = state.getChatListUpdate();
            expect(list.entries).toHaveLength(1);
            expect(list.entries[0]).toMatchObject({
                id: 'chat-1',
                title: 'Hello',
                status: 'idle',
            });
        });

        it('should update an existing entry', () => {
            state.addOrUpdateEntry('chat-1', { title: 'Hello', status: 'idle' });
            state.addOrUpdateEntry('chat-1', { title: 'Updated' });
            const list = state.getChatListUpdate();
            expect(list.entries).toHaveLength(1);
            expect(list.entries[0].title).toBe('Updated');
        });

        it('should preserve existing fields when updating partially', () => {
            state.addOrUpdateEntry('chat-1', { title: 'Hello', status: 'generating' });
            state.addOrUpdateEntry('chat-1', { title: 'Updated' });
            const list = state.getChatListUpdate();
            expect(list.entries[0].status).toBe('generating');
        });

        it('should default title to "New Chat"', () => {
            state.addOrUpdateEntry('chat-1', {});
            const list = state.getChatListUpdate();
            expect(list.entries[0].title).toBe('New Chat');
        });

        it('should update status', () => {
            state.addOrUpdateEntry('chat-1', { title: 'Hello', status: 'idle' });
            state.updateStatus('chat-1', 'generating');
            const list = state.getChatListUpdate();
            expect(list.entries[0].status).toBe('generating');
        });

        it('should ignore updateStatus for non-existent chat', () => {
            state.updateStatus('nonexistent', 'generating');
            const list = state.getChatListUpdate();
            expect(list.entries).toHaveLength(0);
        });

        it('should remove an entry', () => {
            state.addOrUpdateEntry('chat-1', { title: 'Hello' });
            state.removeEntry('chat-1');
            const list = state.getChatListUpdate();
            expect(list.entries).toHaveLength(0);
        });

        it('should clear selectedChatId when removing the selected chat', () => {
            state.addOrUpdateEntry('chat-1', { title: 'Hello' });
            state.selectedChatId = 'chat-1';
            state.removeEntry('chat-1');
            expect(state.selectedChatId).toBeNull();
        });

        it('should return entries in reverse order', () => {
            state.addOrUpdateEntry('chat-1', { title: 'First' });
            state.addOrUpdateEntry('chat-2', { title: 'Second' });
            state.addOrUpdateEntry('chat-3', { title: 'Third' });
            const list = state.getChatListUpdate();
            expect(list.entries.map(e => e.title)).toEqual(['Third', 'Second', 'First']);
        });
    });

    describe('pending new chat', () => {
        it('should add a pending chat placeholder', () => {
            state.addPendingNewChat();
            expect(state.hasPendingChat()).toBe(true);
            expect(state.selectedChatId).toBe(PENDING_CHAT_ID);
        });

        it('should remove pending chat', () => {
            state.addPendingNewChat();
            const removed = state.removePendingChat();
            expect(removed).toBe(true);
            expect(state.hasPendingChat()).toBe(false);
            expect(state.selectedChatId).toBeNull();
        });

        it('should return false when removing non-existent pending chat', () => {
            const removed = state.removePendingChat();
            expect(removed).toBe(false);
        });
    });

    describe('selectedChatId', () => {
        it('should start as null', () => {
            expect(state.selectedChatId).toBeNull();
        });

        it('should get and set', () => {
            state.selectedChatId = 'chat-1';
            expect(state.selectedChatId).toBe('chat-1');
        });
    });

    describe('payload and content caching', () => {
        it('should cache payload for rehydration', () => {
            const payload: ChatOpenedParams = {
                chatId: 'chat-1',
                messages: [],
                title: 'Test',
                status: 'idle',
                models: [],
                selectedModel: null,
            } as ChatOpenedParams;
            state.cachePayload('chat-1', payload);
            // Payload is used during rehydration — test via rehydrate
            const sendFn = vi.fn();
            state.rehydrate(sendFn, [{ name: 'test', uri: '/tmp' }]);
            expect(sendFn).toHaveBeenCalledWith('chat/opened', payload);
        });

        it('should push and replay content events', () => {
            const event = { chatId: 'chat-1', content: 'Hello' } as ChatContentReceivedParams;
            state.pushContentEvent('chat-1', event);
            state.pushContentEvent('chat-1', { chatId: 'chat-1', content: ' world' } as ChatContentReceivedParams);

            const sendFn = vi.fn();
            state.rehydrate(sendFn, [{ name: 'test', uri: '/tmp' }]);
            expect(sendFn).toHaveBeenCalledWith('chat/batchContentReceived', [
                event,
                { chatId: 'chat-1', content: ' world' },
            ]);
        });

        it('should clear content events', () => {
            state.pushContentEvent('chat-1', { chatId: 'chat-1', content: 'x' } as ChatContentReceivedParams);
            state.clearContentEvents('chat-1');

            const sendFn = vi.fn();
            state.rehydrate(sendFn, [{ name: 'test', uri: '/tmp' }]);
            // Should NOT have batchContentReceived calls
            const batchCalls = sendFn.mock.calls.filter(c => c[0] === 'chat/batchContentReceived');
            expect(batchCalls).toHaveLength(0);
        });
    });

    describe('rehydrate', () => {
        it('should send workspace folders first', () => {
            const sendFn = vi.fn();
            const folders: WorkspaceFolder[] = [{ name: 'myproject', uri: '/home/user/myproject' }];
            state.rehydrate(sendFn, folders);
            expect(sendFn.mock.calls[0]).toEqual(['server/setWorkspaceFolders', folders]);
        });

        it('should restore selected chat', () => {
            const payload = { chatId: 'chat-1', messages: [], title: 'T', status: 'idle', models: [], selectedModel: null } as ChatOpenedParams;
            state.cachePayload('chat-1', payload);
            state.selectedChatId = 'chat-1';

            const sendFn = vi.fn();
            state.rehydrate(sendFn, []);
            const selectCalls = sendFn.mock.calls.filter(c => c[0] === 'chat/selectChat');
            expect(selectCalls).toHaveLength(1);
            expect(selectCalls[0][1]).toBe('chat-1');
        });

        it('should not restore selection for non-cached chat', () => {
            state.selectedChatId = 'chat-999';

            const sendFn = vi.fn();
            state.rehydrate(sendFn, []);
            const selectCalls = sendFn.mock.calls.filter(c => c[0] === 'chat/selectChat');
            expect(selectCalls).toHaveLength(0);
        });
    });

    describe('workspace folder name', () => {
        it('should use folder name from workspace folders', () => {
            const s = createState([{ name: 'my-project', uri: '/home/user/my-project' }]);
            s.addOrUpdateEntry('chat-1', { title: 'Test' });
            const list = s.getChatListUpdate();
            expect(list.entries[0].workspaceFolderName).toBe('my-project');
            expect(list.activeWorkspaceFolderName).toBe('my-project');
        });
    });
});
