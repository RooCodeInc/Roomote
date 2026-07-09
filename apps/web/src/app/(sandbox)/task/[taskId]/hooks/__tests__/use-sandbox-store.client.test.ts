import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:password@localhost:5432/test',
    },
  };
});

import {
  acpAssistantChunk,
  acpConfigOptionUpdate,
  acpCurrentModeUpdate,
  acpEvent,
  acpEnvelope,
  acpPermissionsStateUpdate,
  acpPlan,
  acpQueuedMessagesUpdate,
  acpRequestUserInput,
  acpRequestUserInputResponse,
  acpToolResult,
  acpToolCall,
  acpToolCallUpdate,
  acpUsageUpdate,
  acpUserPrompt,
  createAcpStore,
  emitAcp,
  loadAcpHistory,
  textBlock,
} from './use-sandbox-store-test-kit';

describe('createSandboxStore', () => {
  it('stores initial current user info in state', () => {
    const store = createAcpStore({
      userId: 'user-casey',
      userName: 'Casey',
      userEmail: 'casey@example.com',
      userImageUrl: 'https://example.com/casey.png',
    });

    expect(store.getState().currentUserInfo).toEqual({
      userId: 'user-casey',
      userName: 'Casey',
      userEmail: 'casey@example.com',
      userImageUrl: 'https://example.com/casey.png',
    });
  });

  it('skips current user updates when the rendered identity is unchanged', () => {
    const store = createAcpStore({
      userId: 'user-casey',
      userName: 'Casey',
      userEmail: 'casey@example.com',
      userImageUrl: 'https://example.com/casey.png',
    });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.getState()._setCurrentUser({
      userId: 'user-casey',
      userName: 'Casey',
      userEmail: 'casey@example.com',
      userImageUrl: 'https://example.com/casey.png',
    });

    expect(listener).not.toHaveBeenCalled();

    store.getState()._setCurrentUser({
      userId: 'user-robin',
      userName: 'Robin',
      userEmail: 'robin@example.com',
      userImageUrl: 'https://example.com/robin.png',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().currentUserInfo).toEqual({
      userId: 'user-robin',
      userName: 'Robin',
      userEmail: 'robin@example.com',
      userImageUrl: 'https://example.com/robin.png',
    });

    unsubscribe();
  });

  it('resolves live current-user prompts from the local userId mapping', () => {
    const store = createAcpStore({
      userId: 'user-casey',
      userName: 'Casey',
      userEmail: 'casey@example.com',
      userImageUrl: 'https://example.com/casey.png',
    });

    emitAcp(
      store,
      acpUserPrompt('hello from web', {
        ts: 5002,
        text: 'hello from web',
        userId: 'user-casey',
      }),
    );

    const message = store.getState().messages[0];
    expect(message).toMatchObject({
      userId: 'user-casey',
      userName: 'Casey',
      userEmail: 'casey@example.com',
      userImageUrl: 'https://example.com/casey.png',
    });
  });

  it('appends ACP user prompts directly from live events', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpUserPrompt('hello from web', {
        ts: 5001,
        text: 'hello from web',
        clientMessageId: 'client-message-1',
      }),
    );

    const messages = store.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('hello from web');
    expect(messages[0]?.clientMessageId).toBe('client-message-1');
    expect(messages[0]?.optimistic).toBeUndefined();
  });

  it('replaces duplicate user prompts with the same clientMessageId', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpUserPrompt('How about now', {
        id: 'live:user-message-1',
        ts: 5001,
        text: 'How about now',
        clientMessageId: 'client-message-1',
      }),
      acpUserPrompt('How about now', {
        id: 'live:user-message-duplicate',
        ts: 5002,
        text: 'How about now',
        clientMessageId: 'client-message-1',
      }),
    );

    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        id: 'live:user-message-1',
        text: 'How about now',
        clientMessageId: 'client-message-1',
      }),
    ]);
    expect(store.getState().messages).toHaveLength(1);
  });

  it('replaces an optimistic user prompt when the persisted prompt arrives', () => {
    const store = createAcpStore();

    store.getState()._appendOptimisticAcpEvent(
      acpUserPrompt('hello from web', {
        id: 'local:client-message-1',
        ts: 5001,
        text: 'hello from web',
        clientMessageId: 'client-message-1',
      }),
    );

    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        id: 'local:client-message-1',
        text: 'hello from web',
        clientMessageId: 'client-message-1',
        optimistic: true,
      }),
    ]);

    emitAcp(
      store,
      acpUserPrompt('hello from web', {
        id: 'persisted:client-message-1',
        ts: 5002,
        text: 'hello from web',
        clientMessageId: 'client-message-1',
      }),
    );

    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        id: 'local:client-message-1',
        text: 'hello from web',
        clientMessageId: 'client-message-1',
        optimistic: false,
      }),
    ]);
    expect(store.getState().messages).toHaveLength(1);
  });

  it('replaces an optimistic user prompt when refreshed history includes the persisted prompt', () => {
    const store = createAcpStore();

    store.getState()._appendOptimisticAcpEvent(
      acpUserPrompt('What time now', {
        id: 'local:client-message-1',
        ts: 5001,
        text: 'What time now',
        clientMessageId: 'client-message-1',
      }),
    );

    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted:user-message-1',
        ts: 5002,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        text: 'What time now',
        role: 'user',
        contentBlocks: [textBlock('What time now')],
        metadata: {
          sessionId: 'session-1',
          sequence: 2,
        },
        payload: {
          sessionUpdate: 'user_prompt',
          content: textBlock('What time now'),
        },
      }),
    ]);

    expect(store.getState().messages).toMatchObject([
      {
        id: 'persisted:user-message-1',
        text: 'What time now',
        optimistic: undefined,
      },
    ]);
    expect(store.getState().messages).toHaveLength(1);
  });

  it('replaces a live Slack user prompt when refreshed history includes the persisted prompt', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpUserPrompt('So what is it', {
        id: 'live:slack-follow-up',
        ts: 5001,
        text: 'So what is it',
        clientMessageId: 'slack:1710000000.123',
      }),
    );

    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted:slack-follow-up',
        ts: 5002,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        text: 'So what is it',
        role: 'user',
        contentBlocks: [textBlock('So what is it')],
        metadata: {
          sessionId: 'session-1',
          sequence: 2,
          clientMessageId: 'slack:1710000000.123',
        },
        payload: {
          sessionUpdate: 'user_prompt',
          content: textBlock('So what is it'),
          clientMessageId: 'slack:1710000000.123',
        },
      }),
    ]);

    // The refreshed history is authoritative: the surviving message is the
    // persisted envelope (its id is the durable anchor used by reloads and
    // the historical view), not the ephemeral live twin.
    expect(store.getState().messages).toMatchObject([
      {
        id: 'persisted:slack-follow-up',
        text: 'So what is it',
        clientMessageId: 'slack:1710000000.123',
      },
    ]);
    expect(store.getState().messages).toHaveLength(1);
  });

  it('replaces an optimistic user prompt when the live prompt carries clientMessageId in metadata', () => {
    const store = createAcpStore();

    store.getState()._appendOptimisticAcpEvent(
      acpUserPrompt('hello from web', {
        id: 'local:client-message-1',
        ts: 5001,
        text: 'hello from web',
        clientMessageId: 'client-message-1',
      }),
    );

    emitAcp(
      store,
      acpUserPrompt('hello from web', {
        id: 'persisted:client-message-1',
        ts: 5002,
        text: 'hello from web',
        metadata: {
          sessionId: 'session-1',
          sequence: 2,
          clientMessageId: 'client-message-1',
          userId: 'user-casey',
          userName: 'Casey',
          userImageUrl: 'https://example.com/casey.png',
        },
      }),
    );

    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        id: 'local:client-message-1',
        text: 'hello from web',
        clientMessageId: 'client-message-1',
        optimistic: false,
        userId: 'user-casey',
        userName: 'Casey',
        userImageUrl: 'https://example.com/casey.png',
      }),
    ]);
    expect(store.getState().messages).toHaveLength(1);
  });

  it('removes an optimistic user prompt by clientMessageId', () => {
    const store = createAcpStore();

    store.getState()._appendOptimisticAcpEvent(
      acpUserPrompt('hello from web', {
        id: 'local:client-message-1',
        ts: 5001,
        text: 'hello from web',
        clientMessageId: 'client-message-1',
      }),
    );

    store
      .getState()
      ._removeOptimisticMessageByClientMessageId('client-message-1');

    expect(store.getState().messages).toEqual([]);
  });

  it('moves an optimistic transcript prompt into the queue when a queued snapshot arrives', () => {
    const store = createAcpStore();

    store.getState()._appendOptimisticAcpEvent(
      acpUserPrompt('hello from web', {
        id: 'local:client-message-1',
        ts: 5001,
        text: 'hello from web',
        clientMessageId: 'client-message-1',
      }),
    );

    emitAcp(
      store,
      acpQueuedMessagesUpdate(
        [
          {
            id: 'queued-1',
            text: 'hello from web',
            clientMessageId: 'client-message-1',
            timestamp: 5002,
          },
        ],
        {
          sessionId: 'session-queue-promote',
          ts: 5002,
        },
      ),
    );

    expect(store.getState().messages).toEqual([]);
    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'queued-1',
        text: 'hello from web',
        clientMessageId: 'client-message-1',
        timestamp: 5002,
      },
    ]);
  });

  it('keeps an optimistic queued message visible until the persisted prompt arrives', () => {
    const store = createAcpStore();

    store.getState()._appendOptimisticQueuedMessage({
      id: 'local:client-message-1',
      text: 'queued follow-up',
      clientMessageId: 'client-message-1',
      timestamp: 5001,
    });

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'local:client-message-1',
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
        timestamp: 5001,
        optimistic: true,
      },
    ]);

    emitAcp(
      store,
      acpQueuedMessagesUpdate(
        [
          {
            id: 'queued-1',
            text: 'queued follow-up',
            clientMessageId: 'client-message-1',
            timestamp: 5002,
          },
        ],
        {
          sessionId: 'session-queue-live',
          ts: 5002,
        },
      ),
    );

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'queued-1',
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
        timestamp: 5002,
      },
    ]);

    emitAcp(
      store,
      acpQueuedMessagesUpdate([], {
        cause: 'dequeue',
        sessionId: 'session-queue-live',
        sequence: 2,
        ts: 5003,
      }),
    );

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'local:client-message-1',
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
        timestamp: 5001,
        optimistic: true,
      },
    ]);

    emitAcp(
      store,
      acpUserPrompt('queued follow-up', {
        id: 'persisted:client-message-1',
        ts: 5004,
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
      }),
    );

    expect(store.getState().queuedMessages).toEqual([]);
    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        id: 'persisted:client-message-1',
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
      }),
    ]);
  });

  it.each(['delete', 'clear'] as const)(
    'drops acknowledged optimistic queued messages when the runtime queue is %s',
    (cause) => {
      const store = createAcpStore();

      store.getState()._appendOptimisticQueuedMessage({
        id: 'local:client-message-1',
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
        timestamp: 5001,
      });

      emitAcp(
        store,
        acpQueuedMessagesUpdate(
          [
            {
              id: 'queued-1',
              text: 'queued follow-up',
              clientMessageId: 'client-message-1',
              timestamp: 5002,
            },
          ],
          {
            cause: 'enqueue',
            sessionId: 'session-queue-delete',
            ts: 5002,
          },
        ),
      );

      expect(store.getState().queuedMessages).toEqual([
        {
          id: 'queued-1',
          text: 'queued follow-up',
          clientMessageId: 'client-message-1',
          timestamp: 5002,
        },
      ]);

      emitAcp(
        store,
        acpQueuedMessagesUpdate([], {
          cause,
          sessionId: 'session-queue-delete',
          sequence: 2,
          ts: 5003,
        }),
      );

      expect(store.getState().queuedMessages).toEqual([]);
      expect(store.getState().optimisticQueuedMessages).toEqual([]);
    },
  );

  it('removes queued messages with the same clientMessageId when the persisted prompt arrives', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpQueuedMessagesUpdate(
        [
          {
            id: 'queued-1',
            text: 'queued follow-up',
            clientMessageId: 'client-message-1',
            timestamp: 5002,
          },
        ],
        {
          sessionId: 'session-queue-live',
          ts: 5002,
        },
      ),
      acpUserPrompt('queued follow-up', {
        id: 'persisted:client-message-1',
        ts: 5003,
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
      }),
    );

    expect(store.getState().queuedMessages).toEqual([]);
    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        id: 'persisted:client-message-1',
        text: 'queued follow-up',
        clientMessageId: 'client-message-1',
      }),
    ]);
  });

  it('tracks pending request_user_input prompts from live events and appends the response as a user message', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpRequestUserInput({
        requestId: 'rui:session-1:turn-1:call-1',
        questions: [
          {
            id: 'language',
            header: 'Language',
            question: 'Which language should I use?',
            isOther: true,
            isSecret: false,
            options: [
              {
                label: 'TypeScript',
                description: 'Use the existing app stack.',
              },
            ],
          },
        ],
      }),
    );

    expect(store.getState().pendingUserInputRequests).toEqual([
      expect.objectContaining({
        requestId: 'rui:session-1:turn-1:call-1',
        status: 'pending',
      }),
    ]);
    expect(store.getState().messages).toHaveLength(0);

    emitAcp(
      store,
      acpRequestUserInputResponse({
        requestId: 'rui:session-1:turn-1:call-1',
        answers: {
          language: {
            answers: ['TypeScript'],
          },
        },
        resolution: 'submitted',
      }),
    );

    expect(store.getState().pendingUserInputRequests).toEqual([]);
    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        role: 'user',
        kind: 'text',
        text: 'TypeScript',
        updateType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
        data: expect.objectContaining({
          request: expect.objectContaining({
            requestId: 'rui:session-1:turn-1:call-1',
          }),
        }),
      }),
    ]);
  });

  it('uses current user info for request_user_input responses without embedded identity fields', () => {
    const store = createAcpStore({
      userId: 'user-casey',
      userName: 'Casey',
      userEmail: 'casey@example.com',
      userImageUrl: 'https://example.com/casey.png',
    });

    emitAcp(
      store,
      acpRequestUserInput({
        requestId: 'rui:session-1:turn-1:call-avatar',
        questions: [
          {
            id: 'language',
            header: 'Language',
            question: 'Which language should I use?',
            isOther: true,
            isSecret: false,
            options: [
              {
                label: 'TypeScript',
                description: 'Use the existing app stack.',
              },
            ],
          },
        ],
      }),
      acpRequestUserInputResponse({
        requestId: 'rui:session-1:turn-1:call-avatar',
        answers: {
          language: {
            answers: ['TypeScript'],
          },
        },
        resolution: 'submitted',
      }),
    );

    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        role: 'user',
        updateType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
        userName: 'Casey',
        userEmail: 'casey@example.com',
        userImageUrl: 'https://example.com/casey.png',
      }),
    ]);
  });

  it('tracks pending env-var requests from live MCP tool results and clears them after fulfillment', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolResult({
        toolCallId: 'tool-call-env-1',
        ts: 12,
        payload: {
          isMcp: true,
          toolName: 'request_environment_variables',
          mcpToolName: 'request_environment_variables',
          output: JSON.stringify({
            success: true,
            requestCreated: true,
            requestedNames: ['OPENAI_API_KEY', 'STRIPE_API_KEY'],
          }),
        },
      }),
    );

    expect(store.getState().pendingEnvVarRequest).toEqual({
      key: 'tool-call-env-1',
      ts: 12,
      variables: [{ name: 'OPENAI_API_KEY' }, { name: 'STRIPE_API_KEY' }],
    });

    emitAcp(
      store,
      acpUserPrompt('env vars are configured', {
        ts: 13,
        clientMessageId:
          'env-var-request-fulfilled:env-var-request-live-fulfilled',
      }),
    );

    expect(store.getState().pendingEnvVarRequest).toBeNull();
  });

  it('hydrates pending env-var requests from ACP history', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'env-var-request-history',
        ts: 21,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        kind: 'tool_result',
        role: 'tool',
        payload: {
          isMcp: true,
          toolName: 'request_environment_variables',
          mcpToolName: 'request_environment_variables',
          output: JSON.stringify({
            success: true,
            requestCreated: true,
            requestedNames: ['ANTHROPIC_API_KEY'],
          }),
        },
      }),
    );

    expect(store.getState().pendingEnvVarRequest).toEqual({
      key: 'env-var-request-history',
      ts: 21,
      variables: [{ name: 'ANTHROPIC_API_KEY' }],
    });
  });

  it('syncs pending request_user_input prompts from the live sandbox state after refresh', () => {
    const store = createAcpStore();

    store.getState()._syncPendingUserInputRequests([
      {
        requestId: 'rui:session-1:turn-1:call-live',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-live',
        status: 'pending',
        ts: 7001,
        questions: [
          {
            id: 'layout',
            header: 'Layout',
            question: 'What should the UI optimize for?',
            isOther: true,
            isSecret: false,
            options: [
              {
                label: 'Dashboard',
                description: 'Pane-first interface.',
              },
            ],
          },
        ],
      },
    ]);

    expect(store.getState().pendingUserInputRequests).toEqual([
      expect.objectContaining({
        requestId: 'rui:session-1:turn-1:call-live',
        ts: 7001,
      }),
    ]);

    emitAcp(
      store,
      acpRequestUserInputResponse({
        requestId: 'rui:session-1:turn-1:call-live',
        answers: {
          layout: {
            answers: ['Dashboard'],
          },
        },
        resolution: 'submitted',
      }),
    );

    expect(store.getState().pendingUserInputRequests).toEqual([]);
    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        role: 'user',
        kind: 'text',
        text: 'Dashboard',
        updateType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      }),
    ]);
  });

  it('extracts image attachments from ACP user_prompt events', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpEvent({
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        role: 'user',
        ts: 6001,
        text: 'look at this image',
        contentBlocks: [
          {
            type: 'image',
            data: 'aGVsbG8=',
            mimeType: 'image/png',
          },
          textBlock('look at this image'),
        ],
        payload: {
          sessionUpdate: 'user_prompt',
          prompt: [
            {
              type: 'image',
              data: 'aGVsbG8=',
              mimeType: 'image/png',
            },
            textBlock('look at this image'),
          ],
          clientMessageId: 'client-message-image',
        },
      }),
    );

    const messages = store.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      images: ['data:image/png;base64,aGVsbG8='],
      clientMessageId: 'client-message-image',
    });
  });

  it('merges ACP assistant chunks into one message and finalizes on boundary updates', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpAssistantChunk('Hello', { ts: 1001, text: 'Hello' }),
      acpAssistantChunk(' world', {
        sequence: 2,
        ts: 1002,
        text: ' world',
      }),
      acpPlan([{ content: 'Done', status: 'completed' }], {
        sequence: 3,
        ts: 1003,
      }),
    );

    const messages = store.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.kind).toBe('text');
    expect(messages[0]?.text).toBe('Hello world');
    expect(messages[0]?.partial).toBe(false);
  });

  it('replays pending request_user_input prompts from history, drops resolved ones, and preserves the submitted response in the transcript', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'req-1',
        ts: 100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        payload: {
          requestId: 'rui:session-1:turn-1:call-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [
            {
              id: 'color',
              header: 'Color',
              question: 'Pick a color',
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: 'Blue',
                  description: 'Use blue.',
                },
              ],
            },
          ],
        },
      }),
      acpEnvelope({
        id: 'req-2',
        ts: 110,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        payload: {
          requestId: 'rui:session-1:turn-1:call-2',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-2',
          status: 'pending',
          questions: [
            {
              id: 'shape',
              header: 'Shape',
              question: 'Pick a shape',
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: 'Circle',
                  description: 'Use circle.',
                },
              ],
            },
          ],
        },
      }),
      acpEnvelope({
        id: 'resp-2',
        ts: 120,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
        kind: 'unknown',
        role: 'user',
        payload: {
          requestId: 'rui:session-1:turn-1:call-2',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-2',
          answers: {
            shape: {
              answers: ['Circle'],
            },
          },
          resolution: 'submitted',
        },
      }),
    );

    expect(store.getState().pendingUserInputRequests).toEqual([
      expect.objectContaining({
        requestId: 'rui:session-1:turn-1:call-1',
      }),
    ]);
    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        role: 'user',
        kind: 'text',
        text: 'Circle',
        updateType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
        data: expect.objectContaining({
          request: expect.objectContaining({
            requestId: 'rui:session-1:turn-1:call-2',
          }),
        }),
      }),
    ]);
  });

  it('keeps masking secret answers after a history refetch over a pending request', () => {
    const store = createAcpStore();
    const secretQuestions = [
      {
        id: 'api_key',
        header: 'API key',
        question: 'Enter the API key',
        isOther: true,
        isSecret: true,
        options: [
          {
            label: 'Provided',
            description: 'Use a provided key.',
          },
        ],
      },
    ];

    // The pending request arrives in the persisted history...
    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted:secret-request',
        ts: 9100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        metadata: {
          sessionId: 'session-1',
        },
        payload: {
          requestId: 'rui:session-1:turn-1:call-secret-refetch',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-secret-refetch',
          status: 'pending',
          questions: secretQuestions,
        },
      }),
    ]);

    // ...and the live response lands after the refetch. The refetch must
    // not have discarded the pending-request lookup, or the secret answer
    // renders raw.
    emitAcp(
      store,
      acpRequestUserInputResponse({
        requestId: 'rui:session-1:turn-1:call-secret-refetch',
        answers: {
          api_key: {
            answers: ['sk-secret-value'],
          },
        },
      }),
    );

    const responseMessage = store
      .getState()
      .messages.find((msg) => msg.role === 'user' && msg.kind === 'text');
    expect(responseMessage?.text).toBe('[hidden]');
    expect(responseMessage?.text).not.toContain('sk-secret-value');
  });

  it('converges todos to an intentionally empty plan on refetch', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpPlan(
        [
          { id: '1', content: 'Investigate', status: 'in_progress' },
          { id: '2', content: 'Fix', status: 'pending' },
        ],
        {
          id: 'live-plan-clear-1',
          ts: 9200,
          sessionId: 'session-todo-clear',
        },
      ),
    );
    expect(store.getState().todos).toHaveLength(2);

    // Server history's latest plan state is an intentionally empty list.
    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted-plan-clear',
        ts: 9300,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        metadata: {
          sessionId: 'session-todo-clear',
        },
        payload: {
          entries: [],
        },
      }),
    ]);

    expect(store.getState().todos).toEqual([]);
  });

  it('drops pending user input requests when the task aborts', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpRequestUserInput({
        requestId: 'rui:session-1:turn-1:call-aborted',
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Pick one',
            isOther: false,
            isSecret: false,
            options: [{ label: 'A', description: 'Option A.' }],
          },
        ],
      }),
    );
    expect(store.getState().pendingUserInputRequests).toHaveLength(1);

    // Cancel/session-error clears the worker-side map and emits a
    // taskAborted status; the client must drop the stale question too.
    store.getState()._setTaskStatus({
      phase: 'waiting_for_prompt',
      taskStateEvent: 'taskAborted',
      sessionId: 'session-1',
      isConnected: true,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    });

    expect(store.getState().pendingUserInputRequests).toEqual([]);
  });

  it('does not mark the trailing assistant message as completed when merging while running', () => {
    const store = createAcpStore();

    store.getState()._setTaskStatus({
      phase: 'running',
      taskStateEvent: 'taskStarted',
      sessionId: 'session-1',
      isConnected: true,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    });

    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted:running-user',
        ts: 9400,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        text: 'Keep going',
        role: 'user',
        contentBlocks: [textBlock('Keep going')],
        metadata: { sessionId: 'session-1' },
        payload: { sessionId: 'session-1', text: 'Keep going' },
      }),
      acpEnvelope({
        id: 'persisted:running-assistant',
        ts: 9500,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        kind: 'text',
        text: 'Working on it.',
        role: 'assistant',
        contentBlocks: [textBlock('Working on it.')],
        metadata: { sessionId: 'session-1' },
        payload: { sessionId: 'session-1', text: 'Working on it.' },
      }),
    ]);

    const trailing = store
      .getState()
      .messages.findLast((message) => message.role === 'assistant');
    expect(trailing?.isTurnCompletion).not.toBe(true);
  });

  it('treats history todowrite tool updates as authoritative plan state', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpPlan(
        [
          { id: 'stale-1', content: 'Old live todo', status: 'pending' },
          { id: 'stale-2', content: 'Another old todo', status: 'pending' },
        ],
        {
          id: 'live-plan-stale',
          ts: 9600,
          sessionId: 'session-todowrite-branch',
        },
      ),
    );
    expect(store.getState().todos).toHaveLength(2);

    const historyTodos = [
      {
        id: 'fresh-1',
        content: 'Persisted todo from history',
        status: 'in_progress',
      },
    ];

    // Plan state arriving through a ToolCallUpdate todowrite envelope (not a
    // Plan or ToolResult envelope) must still count as plan history.
    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted-todowrite-update',
        ts: 9700,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
        kind: 'tool_result',
        role: 'tool',
        contentBlocks: [textBlock('todowrite')],
        metadata: {
          sessionId: 'session-todowrite-branch',
          toolCallId: 'call_todowrite_branch',
          status: 'completed',
        },
        payload: {
          sessionId: 'session-todowrite-branch',
          toolCallId: 'call_todowrite_branch',
          kind: 'todowrite',
          title: 'todowrite',
          status: 'completed',
          rawInput: { todos: historyTodos },
        },
      }),
    ]);

    expect(store.getState().todos).toMatchObject([
      { id: 'fresh-1', content: 'Persisted todo from history' },
    ]);
  });

  it('keeps a live terminal tool result when history only has the pending call', () => {
    const store = createAcpStore();

    const pendingCallEnvelope = acpEnvelope({
      id: 'persisted:pending-tool-call',
      ts: 9800,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      kind: 'tool_call',
      role: 'tool',
      contentBlocks: [textBlock('read')],
      metadata: {
        sessionId: 'session-1',
        toolCallId: 'call_pending_result',
        status: 'running',
      },
      payload: {
        sessionId: 'session-1',
        toolCallId: 'call_pending_result',
        title: 'read',
        kind: 'read',
        status: 'running',
      },
    });

    store.getState()._loadAcpHistory([pendingCallEnvelope]);

    // The terminal result arrives over the live socket...
    emitAcp(
      store,
      acpToolCallUpdate({
        toolCallId: 'call_pending_result',
        id: 'live:tool-terminal',
        ts: 9900,
        payload: {
          status: 'completed',
          output: 'file contents here',
        },
      }),
    );

    // ...and the next refetch still only has the pending call persisted.
    store.getState()._mergeAcpHistory([pendingCallEnvelope]);

    const toolMessages = store
      .getState()
      .messages.filter(
        (message) => message.toolCallId === 'call_pending_result',
      );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.kind).toBe('tool_result');
    expect(toolMessages[0]?.text).toContain('file contents here');
  });

  it('keeps a live terminal tool result when history only has an in-progress update', () => {
    const store = createAcpStore();

    const pendingCallEnvelope = acpEnvelope({
      id: 'persisted:inprogress-tool-call',
      ts: 10000,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      kind: 'tool_call',
      role: 'tool',
      contentBlocks: [textBlock('shell')],
      metadata: {
        sessionId: 'session-1',
        toolCallId: 'call_inprogress_result',
        status: 'running',
      },
      payload: {
        sessionId: 'session-1',
        toolCallId: 'call_inprogress_result',
        title: 'shell',
        kind: 'execute',
        status: 'running',
      },
    });
    const inProgressUpdateEnvelope = acpEnvelope({
      id: 'persisted:inprogress-tool-update',
      ts: 10100,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
      kind: 'tool_result',
      role: 'tool',
      contentBlocks: [textBlock('partial output')],
      metadata: {
        sessionId: 'session-1',
        toolCallId: 'call_inprogress_result',
        status: 'running',
      },
      payload: {
        sessionId: 'session-1',
        toolCallId: 'call_inprogress_result',
        title: 'shell',
        kind: 'execute',
        status: 'running',
        output: 'partial output',
      },
    });

    store
      .getState()
      ._loadAcpHistory([pendingCallEnvelope, inProgressUpdateEnvelope]);

    emitAcp(
      store,
      acpToolCallUpdate({
        toolCallId: 'call_inprogress_result',
        id: 'live:tool-final',
        ts: 10200,
        payload: {
          status: 'completed',
          output: 'full final output',
        },
      }),
    );

    // Refetch still only has the call + in-progress update persisted.
    store
      .getState()
      ._mergeAcpHistory([pendingCallEnvelope, inProgressUpdateEnvelope]);

    const toolMessages = store
      .getState()
      .messages.filter(
        (message) => message.toolCallId === 'call_inprogress_result',
      );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.kind).toBe('tool_result');
    expect(toolMessages[0]?.partial).not.toBe(true);
    expect(toolMessages[0]?.text).toContain('full final output');
  });

  it('masks secret request_user_input responses in the transcript', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpRequestUserInput({
        requestId: 'rui:session-1:turn-1:call-secret',
        questions: [
          {
            id: 'api_key',
            header: 'API key',
            question: 'Enter the API key',
            isOther: true,
            isSecret: true,
            options: [
              {
                label: 'Provided',
                description: 'Use a provided key.',
              },
            ],
          },
        ],
      }),
    );

    emitAcp(
      store,
      acpRequestUserInputResponse({
        requestId: 'rui:session-1:turn-1:call-secret',
        answers: {
          api_key: {
            answers: ['sk-secret-value'],
          },
        },
      }),
    );

    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        role: 'user',
        kind: 'text',
        text: '[hidden]',
      }),
    ]);
  });

  it('does not split an active ACP assistant stream on ignored updates', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpAssistantChunk("The branch is pushed; I'm polling for the", {
        ts: 3001,
        text: "The branch is pushed; I'm polling for the",
      }),
      acpPermissionsStateUpdate({
        sequence: 2,
        ts: 3002,
      }),
      acpAssistantChunk(' PR URL and check status.', {
        sequence: 3,
        ts: 3003,
        text: ' PR URL and check status.',
      }),
      acpPlan([{ content: 'Done', status: 'completed' }], {
        sequence: 4,
        ts: 3004,
      }),
    );

    const messages = store.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.kind).toBe('text');
    expect(messages[0]?.text).toBe(
      "The branch is pushed; I'm polling for the PR URL and check status.",
    );
    expect(messages[0]?.partial).toBe(false);
  });

  it('does not split an active ACP assistant stream on tool_call_update events', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpAssistantChunk(
        'The provider test still had one more unstable dependency: the mocked query client was also being recreated each render, which kept',
        {
          ts: 3101,
          text: 'The provider test still had one more unstable dependency: the mocked query client was also being recreated each render, which kept',
        },
      ),
      acpToolCallUpdate({
        toolCallId: 'call-mid-stream',
        sequence: 2,
        ts: 3102,
        payload: {
          status: 'completed',
          rawOutput: [{ type: 'text', text: 'Typecheck passed' }],
        },
      }),
      acpAssistantChunk(
        ' retriggering the subscription effect. That’s fixed; I’m rerunning the exact same web checks.',
        {
          sequence: 3,
          ts: 3103,
          text: ' retriggering the subscription effect. That’s fixed; I’m rerunning the exact same web checks.',
        },
      ),
      acpPlan([{ content: 'Done', status: 'completed' }], {
        sequence: 4,
        ts: 3104,
      }),
    );

    const messages = store.getState().messages;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.kind).toBe('text');
    expect(messages[0]?.text).toBe(
      'The provider test still had one more unstable dependency: the mocked query client was also being recreated each render, which kept retriggering the subscription effect. That’s fixed; I’m rerunning the exact same web checks.',
    );
    expect(messages[0]?.partial).toBe(false);
    expect(messages[1]?.kind).toBe('tool_result');
  });

  it('updates todo state from ACP plan entries', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpPlan(
        [
          { content: 'Step A', status: 'in_progress' },
          { content: 'Step B', status: 'pending' },
        ],
        { ts: 2001 },
      ),
    );

    expect(store.getState().todos).toEqual([
      { id: '1', content: 'Step A', status: 'in_progress' },
      { id: '2', content: 'Step B', status: 'pending' },
    ]);
  });

  it('clears todo state from empty ACP plan entries', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpPlan([{ content: 'Step A', status: 'in_progress' }], {
        sessionId: 'session-clear-live',
        ts: 2001,
      }),
      acpPlan([], {
        sessionId: 'session-clear-live',
        sequence: 2,
        ts: 2002,
      }),
    );

    expect(store.getState().todos).toEqual([]);
    expect(store.getState().messages).toMatchObject([
      {
        kind: 'plan',
        data: { entries: [] },
        ts: 2002,
      },
    ]);
  });

  it('tracks ACP context usage from usage_update events', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpUsageUpdate({
        sessionId: 'session-usage-live',
        ts: 2000,
        used: 22_786,
        size: 258_400,
      }),
    );

    expect(store.getState().acpUsage).toEqual({
      usedTokens: 22_786,
      maxTokens: 258_400,
      updatedAt: 2000,
    });
  });

  it('refreshes task status from usage_update payloads', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpUsageUpdate({
        sessionId: 'session-usage-status',
        ts: 2005,
        used: 22_900,
        size: 258_400,
        taskStatus: {
          phase: 'waiting_for_user_input',
          taskStateEvent: null,
          sessionId: 'session-usage-status',
          isConnected: true,
          sleepRemainingMs: 30_000,
          lastErrorMessage: undefined,
        },
      }),
    );

    expect(store.getState().taskStatus).toEqual({
      phase: 'waiting_for_user_input',
      taskStateEvent: null,
      sessionId: 'session-usage-status',
      isConnected: true,
      sleepExpiresAt: expect.any(Number),
      lastErrorMessage: undefined,
    });
  });

  it('marks the last finalized assistant message as a turn completion when taskCompleted arrives', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpAssistantChunk('Done!', {
        ts: 2010,
        text: 'Done!',
      }),
      acpUsageUpdate({
        sessionId: 'session-1',
        ts: 2011,
        used: 22_950,
        size: 258_400,
        taskStatus: {
          phase: 'waiting_for_prompt',
          taskStateEvent: 'taskCompleted',
          sessionId: 'session-1',
          isConnected: true,
          sleepRemainingMs: 30_000,
          lastErrorMessage: undefined,
        },
      }),
    );

    expect(store.getState().messages).toMatchObject([
      expect.objectContaining({
        role: 'assistant',
        kind: 'text',
        text: 'Done!',
        partial: false,
        isTurnCompletion: true,
      }),
    ]);
  });

  it('ignores ACP current_mode_update events in the chat UI', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpCurrentModeUpdate('bypassPermissions', {
        sessionId: 'session-mode-live',
        ts: 2050,
      }),
    );

    expect(store.getState().messages).toHaveLength(0);
  });

  it('ignores ACP config_option_update events in the chat UI', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpConfigOptionUpdate({
        sessionId: 'session-config-live',
        ts: 2075,
        configOptions: [
          {
            id: 'mode',
            value: 'full-access',
          },
        ],
      }),
    );

    expect(store.getState().messages).toHaveLength(0);
  });

  it('updates queued messages from ACP queue update events', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpQueuedMessagesUpdate(
        [
          {
            id: 'queued-1',
            text: 'follow up prompt',
            timestamp: 2100,
          },
        ],
        {
          sessionId: 'session-queue-live',
          ts: 2100,
        },
      ),
    );

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'queued-1',
        text: 'follow up prompt',
        timestamp: 2100,
      },
    ]);
    expect(store.getState().messages).toHaveLength(0);

    emitAcp(
      store,
      acpQueuedMessagesUpdate([], {
        sessionId: 'session-queue-live',
        sequence: 2,
        ts: 2200,
      }),
    );

    expect(store.getState().queuedMessages).toEqual([]);
  });

  it('does not clear queued messages when task status stays in running', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpQueuedMessagesUpdate(
        [
          {
            id: 'queued-running-1',
            text: 'keep this queued prompt',
            timestamp: 2_100,
          },
        ],
        {
          sessionId: 'session-queue-running',
          ts: 2_100,
        },
      ),
    );

    store.getState()._setTaskStatus({
      phase: 'running',
      taskStateEvent: null,
      sessionId: 'session-queue-running',
      isConnected: true,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    });

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'queued-running-1',
        text: 'keep this queued prompt',
        timestamp: 2_100,
      },
    ]);
  });

  it('does not clear queued messages when task status settles to waiting_for_prompt', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpQueuedMessagesUpdate(
        [
          {
            id: 'queued-waiting-1',
            text: 'keep this queued prompt',
            timestamp: 2_150,
          },
        ],
        {
          sessionId: 'session-queue-waiting',
          ts: 2_150,
        },
      ),
    );

    store.getState()._setTaskStatus({
      phase: 'waiting_for_prompt',
      taskStateEvent: 'taskCompleted',
      sessionId: 'session-queue-waiting',
      isConnected: true,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    });

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'queued-waiting-1',
        text: 'keep this queued prompt',
        timestamp: 2_150,
      },
    ]);
  });

  it('hydrates queued messages from the latest persisted ACP queue update envelope', () => {
    const store = createAcpStore();
    store.getState()._setTaskStatus({
      phase: 'running',
      taskStateEvent: null,
      sessionId: 'session-queue-history',
      isConnected: false,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    });

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'queued-envelope-1',
        ts: 3000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate,
        kind: 'unknown',
        role: null,
        metadata: {
          sessionId: 'session-queue-history',
        },
        payload: {
          queuedMessages: [
            {
              id: 'queued-1',
              text: 'first queued prompt',
              timestamp: 3000,
            },
          ],
        },
      }),
      acpEnvelope({
        id: 'queued-envelope-2',
        ts: 3100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate,
        kind: 'unknown',
        role: null,
        metadata: {
          sessionId: 'session-queue-history',
        },
        payload: {
          queuedMessages: [
            {
              id: 'queued-2',
              text: 'latest queued prompt',
              timestamp: 3100,
            },
          ],
        },
      }),
    );

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'queued-2',
        text: 'latest queued prompt',
        timestamp: 3100,
      },
    ]);
  });

  it('hydrates queued messages from persisted history even after the parent turn completed', () => {
    const store = createAcpStore();
    store.getState()._setTaskStatus({
      phase: 'waiting_for_prompt',
      taskStateEvent: 'taskCompleted',
      sessionId: 'session-queue-history-completed',
      isConnected: false,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    });

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'queued-envelope-completed',
        ts: 3200,
        eventType: ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate,
        kind: 'unknown',
        role: null,
        metadata: {
          sessionId: 'session-queue-history-completed',
        },
        payload: {
          queuedMessages: [
            {
              id: 'queued-completed-1',
              text: 'stale queued prompt',
              timestamp: 3200,
            },
          ],
        },
      }),
    );

    expect(store.getState().queuedMessages).toEqual([
      {
        id: 'queued-completed-1',
        text: 'stale queued prompt',
        timestamp: 3200,
      },
    ]);
  });

  it('hydrates ACP todos from persisted ACP plan envelopes', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'plan-envelope-1',
        ts: 5000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        contentBlocks: [
          textBlock(
            '- [in_progress] Read and understand context\n- [pending] Implement fix',
          ),
        ],
        metadata: {
          source: 'plan',
          sessionId: 'session-1',
        },
        payload: {
          sessionId: 'session-1',
          todos: [
            {
              id: '1',
              content: 'Read and understand context',
              status: 'in_progress',
            },
            { id: '2', content: 'Implement fix', status: 'pending' },
          ],
        },
      }),
    );

    const [planMessage, todoSectionMessage] = store.getState().messages;
    expect(planMessage?.kind).toBe('plan');
    expect(todoSectionMessage).toMatchObject({
      kind: 'todo_section',
      data: {
        content: 'Read and understand context',
      },
    });

    if (!planMessage || planMessage.kind !== 'plan') {
      throw new Error('Expected a plan message');
    }

    expect(planMessage.data.entries).toEqual([
      {
        id: '1',
        content: 'Read and understand context',
        status: 'in_progress',
      },
      { id: '2', content: 'Implement fix', status: 'pending' },
    ]);
    expect(store.getState().todos).toEqual([
      {
        id: '1',
        content: 'Read and understand context',
        status: 'in_progress',
      },
      { id: '2', content: 'Implement fix', status: 'pending' },
    ]);
  });

  it('hydrates OpenCode todowrite tool envelopes as ACP todos', () => {
    const store = createAcpStore();

    const todos = [
      {
        id: 't1',
        content: 'Discover repo guidance files for the Roomote repo',
        status: 'in_progress',
        priority: 'medium',
      },
      {
        id: 't2',
        content: 'Read a few representative project files',
        status: 'pending',
        priority: 'medium',
      },
    ];

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'opencode-todowrite-call',
        ts: 5100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        kind: 'tool_call',
        role: 'assistant',
        contentBlocks: [textBlock('todowrite')],
        metadata: {
          sessionId: 'session-opencode-todos',
          turnId: 'msg_1',
          toolCallId: 'call_todo_1',
          status: 'completed',
        },
        payload: {
          sessionId: 'session-opencode-todos',
          turnId: 'msg_1',
          toolCallId: 'call_todo_1',
          kind: 'todowrite',
          title: 'todowrite',
          status: 'completed',
          rawInput: { todos },
        },
      }),
      acpEnvelope({
        id: 'opencode-todowrite-result',
        ts: 5200,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        kind: 'tool_result',
        role: 'tool',
        contentBlocks: [textBlock(JSON.stringify(todos))],
        metadata: {
          sessionId: 'session-opencode-todos',
          turnId: 'msg_1',
          toolCallId: 'call_todo_1',
          status: 'completed',
        },
        payload: {
          sessionId: 'session-opencode-todos',
          turnId: 'msg_1',
          toolCallId: 'call_todo_1',
          kind: 'todowrite',
          title: 'todowrite',
          status: 'completed',
          rawInput: { todos },
          output: JSON.stringify(todos),
        },
      }),
    );

    const messages = store.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.kind)).toEqual([
      'plan',
      'todo_section',
    ]);
    expect(messages[0]).toMatchObject({
      kind: 'plan',
      ts: 5200,
      data: {
        entries: todos,
      },
    });
    expect(messages[1]).toMatchObject({
      kind: 'todo_section',
      data: {
        content: 'Discover repo guidance files for the Roomote repo',
      },
    });
    expect(store.getState().todos).toEqual(todos);
  });

  it('parses live OpenCode todowrite tool updates as ACP todos', () => {
    const store = createAcpStore();
    const todos = [
      {
        id: 't1',
        content: 'Read package files',
        status: 'completed',
      },
      {
        id: 't2',
        content: 'Run renderer tests',
        status: 'in_progress',
      },
    ];

    emitAcp(
      store,
      acpToolCallUpdate({
        sessionId: 'session-opencode-live-todos',
        sequence: 1,
        ts: 5300,
        toolCallId: 'call-live-todos',
        payload: {
          kind: 'todowrite',
          title: 'todowrite',
          status: 'completed',
          rawInput: { todos },
          output: JSON.stringify(todos),
        },
      }),
    );

    expect(store.getState().messages.map((message) => message.kind)).toEqual([
      'plan',
      'todo_section',
    ]);
    expect(store.getState().messages[0]).toMatchObject({
      kind: 'plan',
      data: {
        entries: todos,
      },
    });
    expect(store.getState().messages[1]).toMatchObject({
      kind: 'todo_section',
      data: {
        content: 'Run renderer tests',
      },
    });
    expect(store.getState().todos).toEqual(todos);
  });

  it('deduplicates live OpenCode todowrite updates that carry sessionId in the payload', () => {
    const store = createAcpStore();
    const todos = [
      {
        id: 't1',
        content: 'Inspect git state and recent history for PR delivery',
        status: 'in_progress',
      },
      {
        id: 't2',
        content: 'Capture required visual proof',
        status: 'pending',
      },
    ];

    emitAcp(
      store,
      acpToolCallUpdate({
        id: 'live-todowrite-payload-session-1',
        metadata: {},
        sequence: 1,
        ts: 5400,
        toolCallId: 'call-live-payload-session-todos',
        payload: {
          sessionId: 'session-from-payload',
          kind: 'todowrite',
          title: 'todowrite',
          status: 'completed',
          rawInput: { todos },
          output: JSON.stringify(todos),
        },
      }),
      acpToolCallUpdate({
        id: 'live-todowrite-payload-session-2',
        metadata: {},
        sequence: 2,
        ts: 5401,
        toolCallId: 'call-live-payload-session-todos',
        payload: {
          sessionId: 'session-from-payload',
          kind: 'todowrite',
          title: 'todowrite',
          status: 'completed',
          rawInput: { todos },
          output: JSON.stringify(todos),
        },
      }),
    );

    expect(store.getState().messages.map((message) => message.kind)).toEqual([
      'plan',
      'todo_section',
    ]);
    expect(store.getState().messages[1]).toMatchObject({
      kind: 'todo_section',
      data: {
        content: 'Inspect git state and recent history for PR delivery',
      },
    });
    expect(store.getState().todos).toEqual(todos);
  });

  it('deduplicates repeated live OpenCode todowrite envelopes without a sessionId', () => {
    const store = createAcpStore();
    const todos = [
      {
        id: 't1',
        content: 'Capture required visual proof',
        status: 'in_progress',
      },
    ];

    const event = acpToolCallUpdate({
      id: 'live-todowrite-duplicate-no-session',
      metadata: {},
      sequence: 1,
      ts: 5500,
      toolCallId: 'call-live-duplicate-no-session-todos',
      payload: {
        kind: 'todowrite',
        title: 'todowrite',
        status: 'completed',
        rawInput: { todos },
        output: JSON.stringify(todos),
      },
    });

    emitAcp(store, event, event);

    expect(store.getState().messages.map((message) => message.kind)).toEqual([
      'plan',
      'todo_section',
    ]);
    expect(store.getState().messages[1]).toMatchObject({
      kind: 'todo_section',
      data: {
        content: 'Capture required visual proof',
      },
    });
    expect(store.getState().todos).toEqual(todos);
  });

  it('ignores incomplete live OpenCode todowrite tool updates', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolCallUpdate({
        sessionId: 'session-opencode-live-empty-todos',
        sequence: 1,
        ts: 5300,
        toolCallId: 'call-live-empty-todos',
        payload: {
          kind: 'todowrite',
          title: 'todowrite',
          status: 'in_progress',
        },
      }),
    );

    expect(store.getState().messages).toEqual([]);
    expect(store.getState().todos).toEqual([]);
  });

  it('replaces earlier ACP plan envelopes for the same session', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'plan-envelope-older',
        ts: 5200,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        contentBlocks: [textBlock('- [pending] Read context')],
        metadata: { source: 'plan', sessionId: 'session-plan-history' },
        payload: {
          todos: [{ id: '1', content: 'Read context', status: 'pending' }],
        },
      }),
      acpEnvelope({
        id: 'plan-envelope-newer',
        ts: 5300,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        contentBlocks: [
          textBlock(
            '- [completed] Read context\n- [in_progress] Implement fix',
          ),
        ],
        metadata: { source: 'plan', sessionId: 'session-plan-history' },
        payload: {
          todos: [
            { id: '1', content: 'Read context', status: 'completed' },
            { id: '2', content: 'Implement fix', status: 'in_progress' },
          ],
        },
      }),
    );

    expect(store.getState().messages).toHaveLength(2);
    expect(store.getState().messages[0]).toMatchObject({
      kind: 'plan',
      ts: 5300,
    });
    expect(store.getState().messages[1]).toMatchObject({
      kind: 'todo_section',
      ts: 5300,
      data: {
        content: 'Implement fix',
      },
    });
    expect(store.getState().todos).toEqual([
      { id: '1', content: 'Read context', status: 'completed' },
      { id: '2', content: 'Implement fix', status: 'in_progress' },
    ]);
  });

  it('clears hydrated ACP todos when a newer persisted plan is empty', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'plan-envelope-initial',
        ts: 5200,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        contentBlocks: [textBlock('- [in_progress] Read context')],
        metadata: { source: 'plan', sessionId: 'session-plan-clear-history' },
        payload: {
          entries: [
            { id: '1', content: 'Read context', status: 'in_progress' },
          ],
        },
      }),
      acpEnvelope({
        id: 'plan-envelope-cleared',
        ts: 5300,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        contentBlocks: [],
        metadata: { source: 'plan', sessionId: 'session-plan-clear-history' },
        payload: {
          entries: [],
        },
      }),
    );

    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]).toMatchObject({
      kind: 'plan',
      ts: 5300,
      data: { entries: [] },
    });
    expect(store.getState().todos).toEqual([]);
  });

  it('does not append a todo section message when the next item is still pending', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpPlan(
        [
          {
            id: '1',
            content: 'Read context',
            status: 'in_progress',
          },
          {
            id: '2',
            content: 'Implement fix',
            status: 'pending',
          },
        ],
        {
          id: 'plan-live-1',
          ts: 8000,
          sessionId: 'session-plan-live',
          sequence: 1,
        },
      ),
      acpPlan(
        [
          {
            id: '1',
            content: 'Read context',
            status: 'completed',
          },
          {
            id: '2',
            content: 'Implement fix',
            status: 'pending',
          },
        ],
        {
          id: 'plan-live-2',
          ts: 8100,
          sessionId: 'session-plan-live',
          sequence: 2,
        },
      ),
    );

    expect(store.getState().messages).toMatchObject([
      {
        kind: 'plan',
        ts: 8100,
      },
      {
        kind: 'todo_section',
        data: {
          content: 'Read context',
        },
      },
    ]);
    expect(store.getState().messages).toHaveLength(2);
  });

  it('does not append a duplicate todo section message when the active item is reindexed', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpPlan(
        [
          {
            content: 'Implement fix',
            status: 'in_progress',
          },
        ],
        {
          id: 'plan-live-reindex-1',
          ts: 8200,
          sessionId: 'session-plan-reindex',
          sequence: 1,
        },
      ),
      acpPlan(
        [
          {
            content: 'Read context',
            status: 'pending',
          },
          {
            content: 'Implement fix',
            status: 'in_progress',
          },
        ],
        {
          id: 'plan-live-reindex-2',
          ts: 8300,
          sessionId: 'session-plan-reindex',
          sequence: 2,
        },
      ),
    );

    expect(store.getState().messages).toHaveLength(2);
    expect(store.getState().messages[0]).toMatchObject({
      kind: 'plan',
      ts: 8300,
    });
    expect(store.getState().messages[1]).toMatchObject({
      kind: 'todo_section',
      ts: 8200,
      data: {
        content: 'Implement fix',
      },
    });
  });

  it('does not replay duplicate todo section messages when refreshed history catches up to live plans', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpPlan(
        [
          {
            id: '1',
            content: 'Read context',
            status: 'pending',
          },
          {
            id: '2',
            content: 'Implement fix',
            status: 'pending',
          },
        ],
        {
          id: 'live-plan-1',
          ts: 8400,
          sessionId: 'session-plan-history-replay',
          sequence: 1,
        },
      ),
      acpPlan(
        [
          {
            id: '1',
            content: 'Read context',
            status: 'in_progress',
          },
          {
            id: '2',
            content: 'Implement fix',
            status: 'pending',
          },
        ],
        {
          id: 'live-plan-2',
          ts: 8500,
          sessionId: 'session-plan-history-replay',
          sequence: 2,
        },
      ),
    );

    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted-plan-1',
        ts: 8400,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        metadata: {
          sessionId: 'session-plan-history-replay',
          sequence: 1,
        },
        payload: {
          entries: [
            {
              id: '1',
              content: 'Read context',
              status: 'pending',
            },
            {
              id: '2',
              content: 'Implement fix',
              status: 'pending',
            },
          ],
        },
      }),
      acpEnvelope({
        id: 'persisted-plan-2',
        ts: 8500,
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        kind: 'plan',
        role: 'assistant',
        metadata: {
          sessionId: 'session-plan-history-replay',
          sequence: 2,
        },
        payload: {
          entries: [
            {
              id: '1',
              content: 'Read context',
              status: 'in_progress',
            },
            {
              id: '2',
              content: 'Implement fix',
              status: 'pending',
            },
          ],
        },
      }),
    ]);

    const messages = store.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.kind)).toEqual([
      'plan',
      'todo_section',
    ]);
    expect(messages[1]).toMatchObject({
      kind: 'todo_section',
      data: {
        content: 'Read context',
      },
    });
  });

  it('hydrates persisted ACP user prompt envelopes as user messages', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'user-prompt-envelope-1',
        ts: 6100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        text: 'follow-up from DB',
        role: 'user',
        contentBlocks: [textBlock('follow-up from DB')],
        metadata: {
          source: 'session/prompt',
          sessionId: 'session-user-history',
        },
      }),
    );

    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]).toMatchObject({
      role: 'user',
      kind: 'text',
      partial: false,
      updateType: 'roomote_runtime.user_prompt',
      text: 'follow-up from DB',
    });
  });

  it('hydrates persisted ACP assistant reasoning and message envelopes', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'assistant-thought-envelope-1',
        ts: 7000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
        kind: 'reasoning',
        text: 'Thinking through the fix',
        role: 'assistant',
        contentBlocks: [textBlock('Thinking through the fix')],
        metadata: {
          source: 'assistant_thought',
          sessionId: 'session-text-history',
        },
      }),
      acpEnvelope({
        id: 'assistant-message-envelope-1',
        ts: 7001,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        kind: 'text',
        text: 'I found the root cause.',
        role: 'assistant',
        contentBlocks: [textBlock('I found the root cause.')],
        metadata: {
          source: 'assistant_message',
          sessionId: 'session-text-history',
        },
      }),
    );

    expect(store.getState().messages).toHaveLength(2);
    expect(store.getState().messages[0]).toMatchObject({
      kind: 'reasoning',
      text: 'Thinking through the fix',
      partial: false,
    });
    expect(store.getState().messages[1]).toMatchObject({
      kind: 'text',
      text: 'I found the root cause.',
      partial: false,
    });
  });

  it('dedupes a finalized live assistant chunk when refreshed history includes the persisted final assistant message', () => {
    const store = createAcpStore();

    // The runtime emitter stamps chunks with a chunk-typed logical id; the
    // persisted final message carries the consolidated event type. Both must
    // canonicalize to the same logical identity.
    emitAcp(
      store,
      acpAssistantChunk('Fri Jun 26 16:48:50 UTC 2026', {
        id: 'live-assistant-chunk',
        ts: 400,
        sessionId: 'session-text-history',
        sequence: 4,
        text: 'Fri Jun 26 16:48:50 UTC 2026',
        metadata: {
          sessionId: 'session-text-history',
          turnId: 'turn-1',
          logicalEventId:
            'session-text-history:turn-1:no-tool:roomote_runtime.assistant_message_chunk',
        },
      }),
    );

    store.getState()._setTaskStatus({
      phase: 'waiting_for_prompt',
      sessionId: 'session-text-history',
      taskStateEvent: 'taskCompleted',
      isConnected: true,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    });

    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted-assistant-message',
        ts: 401,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        kind: 'text',
        text: 'Fri Jun 26 16:48:50 UTC 2026',
        role: 'assistant',
        contentBlocks: [textBlock('Fri Jun 26 16:48:50 UTC 2026')],
        metadata: {
          sessionId: 'session-text-history',
          turnId: 'turn-1',
          logicalEventId:
            'session-text-history:turn-1:no-tool:roomote_runtime.assistant_message',
        },
        payload: {
          sessionId: 'session-text-history',
          turnId: 'turn-1',
          text: 'Fri Jun 26 16:48:50 UTC 2026',
          logicalEventId:
            'session-text-history:turn-1:no-tool:roomote_runtime.assistant_message',
        },
      }),
    ]);

    expect(store.getState().messages).toMatchObject([
      {
        id: 'persisted-assistant-message',
        updateType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Fri Jun 26 16:48:50 UTC 2026',
        partial: false,
      },
    ]);
  });

  it('marks a historical assistant message as a turn completion when a later user prompt starts the next turn', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'assistant-message-envelope-1',
        ts: 7050,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        kind: 'text',
        text: 'I found the root cause.',
        role: 'assistant',
        contentBlocks: [textBlock('I found the root cause.')],
        metadata: {
          source: 'assistant_message',
          sessionId: 'session-history-complete',
        },
      }),
      acpEnvelope({
        id: 'user-prompt-envelope-2',
        ts: 7060,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        text: 'Ship it',
        role: 'user',
        contentBlocks: [textBlock('Ship it')],
        metadata: {
          source: 'session/prompt',
          sessionId: 'session-history-complete',
        },
      }),
    );

    expect(store.getState().messages[0]).toMatchObject({
      role: 'assistant',
      kind: 'text',
      text: 'I found the root cause.',
      isTurnCompletion: true,
    });
  });

  it('can skip marking the trailing historical assistant message while a live task is still running', () => {
    const store = createAcpStore();

    store.getState()._loadAcpHistory(
      [
        acpEnvelope({
          id: 'assistant-message-envelope-running',
          ts: 7070,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          kind: 'text',
          text: 'Still working on it.',
          role: 'assistant',
          contentBlocks: [textBlock('Still working on it.')],
          metadata: {
            source: 'assistant_message',
            sessionId: 'session-history-running',
          },
        }),
      ],
      {
        markTrailingAssistantCompletion: false,
      },
    );

    expect(store.getState().messages[0]).toMatchObject({
      role: 'assistant',
      kind: 'text',
      text: 'Still working on it.',
      isTurnCompletion: false,
    });
  });

  it('hydrates persisted ACP tool result envelopes with canonical fields', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'tool-envelope-1',
        ts: 8000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        kind: 'tool_result',
        text: 'Linux test\n',
        role: 'tool',
        contentBlocks: [textBlock('Linux test\n')],
        metadata: {
          source: 'tool_call_update',
          sessionId: 'session-tool-history',
          toolCallId: 'call-history',
          status: 'completed',
        },
        payload: {
          toolCallId: 'call-history',
          kind: 'execute',
          title: 'Run uname -a',
          isExecute: true,
          isMcp: false,
          mcpServerName: null,
          mcpToolName: null,
          command: 'uname -a',
          exitCode: 0,
          output: 'Linux test\n',
          status: 'completed',
        },
      }),
    );

    const message = store.getState().messages[0];
    expect(message?.kind).toBe('tool_result');
    expect(message?.toolCallId).toBe('call-history');
    expect(message?.partial).toBe(false);
    expect(message?.text).toBe('Linux test\n');
  });

  it('orders persisted ACP history by ts before createdAt', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'assistant-message-later-created',
        ts: 9000,
        createdAt: 9100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        kind: 'text',
        text: 'first by ts',
        role: 'assistant',
        contentBlocks: [textBlock('first by ts')],
        metadata: { source: 'assistant_message', sessionId: 'session-sort' },
      }),
      acpEnvelope({
        id: 'assistant-message-earlier-created',
        ts: 9001,
        createdAt: 8900,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        kind: 'text',
        text: 'second by ts',
        role: 'assistant',
        contentBlocks: [textBlock('second by ts')],
        metadata: { source: 'assistant_message', sessionId: 'session-sort' },
      }),
    );

    expect(store.getState().messages.map((message) => message.text)).toEqual([
      'first by ts',
      'second by ts',
    ]);
  });

  it('orders persisted tool-call envelopes by sequence before id when timestamps tie', () => {
    const store = createAcpStore();

    loadAcpHistory(
      store,
      acpEnvelope({
        id: 'tool-update-first-by-id',
        ts: 9100,
        createdAt: 9100,
        sequence: 2,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
        kind: 'tool_result',
        role: 'tool',
        metadata: {
          sessionId: 'session-tool-sequence',
          sequence: 2,
        },
        payload: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-sequence',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Lint complete\n' },
            },
          ],
        },
      }),
      acpEnvelope({
        id: 'tool-call-second-by-id',
        ts: 9100,
        createdAt: 9100,
        sequence: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        kind: 'tool_call',
        role: 'tool',
        metadata: {
          sessionId: 'session-tool-sequence',
          sequence: 1,
        },
        payload: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-sequence',
          title: 'Run pnpm lint',
          kind: 'execute',
          rawInput: {
            source: 'unified_exec_startup',
            parsed_cmd: [{ type: 'execute', cmd: 'pnpm lint' }],
          },
        },
      }),
    );

    const messages = store.getState().messages;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'tool_result',
      toolCallId: 'call-sequence',
      partial: false,
      text: 'Lint complete\n',
      data: {
        title: 'Run pnpm lint',
      },
    });
  });

  it('keeps routing repeated tool_call_update events to the same ACP command message', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolCall({
        ts: 3001,
        toolCallId: 'call-1',
        title: 'Run pnpm install',
        toolKind: 'execute',
        rawInput: {
          source: 'unified_exec_startup',
          parsed_cmd: [{ type: 'execute', cmd: 'pnpm install' }],
        },
      }),
      acpToolCallUpdate({
        sequence: 2,
        ts: 3002,
        toolCallId: 'call-1',
        payload: {
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Progress: step 1\n' },
            },
          ],
        },
      }),
      acpToolCallUpdate({
        sequence: 3,
        ts: 3003,
        toolCallId: 'call-1',
        payload: {
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Progress: step 2\n' },
            },
          ],
        },
      }),
    );

    const messages = store.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('tool_result');
    expect(messages[0]?.text).toBe('Progress: step 2\n');
    expect(messages[0]?.toolCallId).toBe('call-1');
    expect(messages[0]?.partial).toBe(true);
  });

  it('replaces a live terminal tool update when refreshed history includes the persisted tool result', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolCall({
        id: 'live-tool-call',
        ts: 3901,
        sessionId: 'session-tool-history',
        toolCallId: 'call-history-replay',
        title: 'Run tests',
        toolKind: 'execute',
        rawInput: {
          command: ['/bin/bash', '-lc', 'pnpm test'],
        },
      }),
      acpToolCallUpdate({
        id: 'live-tool-update',
        sequence: 2,
        ts: 3902,
        sessionId: 'session-tool-history',
        toolCallId: 'call-history-replay',
        payload: {
          status: 'completed',
          output: 'Live done\n',
        },
      }),
    );

    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted-tool-call',
        ts: 3901,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        kind: 'tool_call',
        role: 'assistant',
        metadata: {
          sessionId: 'session-tool-history',
          toolCallId: 'call-history-replay',
          status: 'completed',
        },
        payload: {
          sessionId: 'session-tool-history',
          toolCallId: 'call-history-replay',
          kind: 'execute',
          title: 'Run tests',
          status: 'completed',
          rawInput: {
            command: ['/bin/bash', '-lc', 'pnpm test'],
          },
        },
      }),
      acpEnvelope({
        id: 'persisted-tool-result',
        ts: 3903,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        kind: 'tool_result',
        role: 'tool',
        contentBlocks: [textBlock('Persisted done\n')],
        metadata: {
          sessionId: 'session-tool-history',
          toolCallId: 'call-history-replay',
          status: 'completed',
        },
        payload: {
          sessionId: 'session-tool-history',
          toolCallId: 'call-history-replay',
          kind: 'execute',
          title: 'Run tests',
          status: 'completed',
          output: 'Persisted done\n',
        },
      }),
    ]);

    const messages = store.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'persisted-tool-result',
      kind: 'tool_result',
      text: 'Persisted done\n',
      toolCallId: 'call-history-replay',
      partial: false,
      data: {
        title: 'Run tests',
        output: 'Persisted done\n',
      },
    });
  });

  it('replaces live synthetic-id messages when history replays the same logical event id', () => {
    const store = createAcpStore();
    const logicalEventId =
      'session-logical:turn-logical:no-tool:roomote_runtime.assistant_thought';

    emitAcp(
      store,
      acpEvent({
        id: 'opencode-server:1',
        ts: 4101,
        sessionId: 'session-logical',
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
        kind: 'reasoning',
        role: 'assistant',
        text: 'Live reasoning',
        contentBlocks: [textBlock('Live reasoning')],
        metadata: {
          sessionId: 'session-logical',
          turnId: 'turn-logical',
          logicalEventId,
        },
        payload: {
          sessionId: 'session-logical',
          turnId: 'turn-logical',
          text: 'Live reasoning',
          logicalEventId,
        },
      }),
    );

    store.getState()._mergeAcpHistory([
      acpEnvelope({
        id: 'persisted-reasoning',
        ts: 4102,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
        kind: 'reasoning',
        role: 'assistant',
        text: 'Persisted reasoning',
        contentBlocks: [textBlock('Persisted reasoning')],
        metadata: {
          sessionId: 'session-logical',
          turnId: 'turn-logical',
          logicalEventId,
        },
        payload: {
          sessionId: 'session-logical',
          turnId: 'turn-logical',
          text: 'Persisted reasoning',
          logicalEventId,
        },
      }),
    ]);

    expect(store.getState().messages).toMatchObject([
      {
        id: 'persisted-reasoning',
        logicalEventId,
        text: 'Persisted reasoning',
      },
    ]);
  });

  it('marks ACP command message complete when tool_call_update has terminal status', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolCall({
        ts: 4001,
        toolCallId: 'call-2',
        title: 'Run pnpm install',
        toolKind: 'execute',
        rawInput: {
          source: 'unified_exec_startup',
          command: ['/bin/bash', '-lc', 'pnpm install'],
        },
      }),
      acpToolCallUpdate({
        sequence: 2,
        ts: 4002,
        toolCallId: 'call-2',
        payload: {
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Done\n' },
            },
          ],
        },
      }),
    );

    const message = store.getState().messages[0];
    expect(message?.kind).toBe('tool_result');
    expect(message?.partial).toBe(false);
  });

  it('marks ACP command message complete when tool_call_update reports running=false', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolCall({
        ts: 5001,
        toolCallId: 'call-3',
        title: 'Run pnpm lint',
        toolKind: 'execute',
        rawInput: {
          source: 'unified_exec_startup',
          parsed_cmd: [{ type: 'execute', cmd: 'pnpm lint' }],
        },
      }),
      acpToolCallUpdate({
        sequence: 2,
        ts: 5002,
        toolCallId: 'call-3',
        payload: {
          running: false,
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Lint complete\n' },
            },
          ],
        },
      }),
    );

    const message = store.getState().messages[0];
    expect(message?.kind).toBe('tool_result');
    expect(message?.partial).toBe(false);
  });

  it('preserves MCP alias fields when tool_call_update omits them', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolCall({
        ts: 5501,
        toolCallId: 'call-browser-mcp',
        title: 'browser-mcp/browser_tabs',
        toolKind: 'mcp',
      }),
      acpToolCallUpdate({
        sequence: 2,
        ts: 5502,
        toolCallId: 'call-browser-mcp',
        payload: {
          status: 'completed',
          output: 'ok',
        },
      }),
    );

    expect(store.getState().messages[0]).toMatchObject({
      kind: 'tool_result',
      toolCallId: 'call-browser-mcp',
      data: {
        isMcp: true,
        serverName: 'browser-mcp',
        toolName: 'browser_tabs',
      },
    });
  });

  it('keeps Claude ACP command messages without inferring a shell command from later tool updates', () => {
    const store = createAcpStore();

    emitAcp(
      store,
      acpToolCall({
        sessionId: 'session-claude',
        ts: 6001,
        toolCallId: 'call-claude-bash',
        title: 'Terminal',
        toolKind: 'execute',
        rawInput: {},
        payload: {
          isExecute: true,
          isRead: false,
          _meta: {
            claudeCode: {
              toolName: 'Bash',
            },
          },
        },
      }),
      acpToolCallUpdate({
        sessionId: 'session-claude',
        sequence: 2,
        ts: 6002,
        toolCallId: 'call-claude-bash',
        payload: {
          kind: 'execute',
          isExecute: true,
          title: 'uname -a',
          rawInput: {
            command: 'uname -a',
            description: 'Run uname -a',
          },
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Run uname -a' },
            },
          ],
        },
      }),
      acpToolCallUpdate({
        sessionId: 'session-claude',
        sequence: 3,
        ts: 6003,
        toolCallId: 'call-claude-bash',
        payload: {
          status: 'completed',
          rawOutput: 'Linux test\n',
        },
      }),
    );

    const message = store.getState().messages[0];
    expect(message?.kind).toBe('tool_result');
    expect(message?.toolCallId).toBe('call-claude-bash');
    expect(message?.partial).toBe(false);
  });
});
