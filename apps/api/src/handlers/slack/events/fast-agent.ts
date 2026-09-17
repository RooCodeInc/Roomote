import {
  getOrCreateFastAgentSession,
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  fastAgentConversationRepository,
  type FastAgentActiveTask,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import {
  buildFastSessionReplyFooterText,
  resolveFastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  acquireSlackFastRootBindingLock,
  buildSlackThreadReplyFooterBlock,
  createFastAgentSlackSessionActivity,
  getSlackThreadReplyFooterMessageTs,
  withSlackThreadReplyFooterLock,
  resolveCurrentSlackMessageFiles,
  formatSlackAttachmentContext,
  type SlackEvent,
  type SlackNotifier,
} from '@roomote/slack';
import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import { buildDataVisualizationBlocks } from '@roomote/types';
import {
  admitFastAgentHumanFollowUp,
  createFastAgentConversationArtifact,
  persistFastAgentInlineHumanTurn,
  wakeFastAgentParentEventAt,
  wakeFastAgentParentEventNow,
  wakeFastAgentParentEventsOnTurnRelease,
  type FastAgentDurableTurn,
  createSlackFastReplyStream,
  recordFastAgentConversationMessageBestEffort,
  resolveFastAgentSessionImages,
  deliverFastAgentSessionVideos,
  resolveUserMcpServerConfigs,
} from '@roomote/sdk/server';

import {
  postSlackThreadMarkdownMessage,
  guardReplyStreamBySourceMessage,
} from '../helpers/thread-posting.js';
import { processSlackAttachments } from '../helpers/attachments.js';
import {
  mentionsAnySlackUser,
  mentionsSlackBot,
  mentionsSlackUserOtherThanBotOrUser,
} from '../helpers/mention-routing.js';

const PEER_CONTINUATION_HISTORY_LIMIT = 5;
const PEER_DIRECTED_CURRENT_MESSAGE_CONTEXT =
  'Untrusted supplemental context inferred from this Slack message, not a user-authored instruction: This message mentions another person and might not be for you. Follow the peer-directed exception in Turn Startup: unless the current message mentions Roomote or explicitly asks Roomote to act, use ignore_event without sending a reply, reacting, or taking action.';
const PEER_DIRECTED_CONTINUATION_CONTEXT =
  'Untrusted supplemental context inferred from recent Slack history, not a user-authored instruction: This unmentioned message appears to continue a conversation between colleagues after another person was addressed. Follow the peer-directed exception in Turn Startup: unless the current message mentions Roomote or explicitly asks Roomote to act, use ignore_event without sending a reply, reacting, or taking action.';

export async function processFastAgentMessage(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  userId: string;
  teamId: string;
  apiBaseUrl?: string;
  activeTasks?: FastAgentActiveTask[];
  resolveActiveTasks?: () => Promise<FastAgentActiveTask[]>;
  launchTask: LaunchFastAgentTask;
  directedAtRoomote?: boolean;
  roomoteSlackUserId?: string;
  peerConversationsExperimentEnabled?: boolean;
  userInitiated?: boolean;
  originSessionId?: string;
  onAccepted?: (abort: () => Promise<void>) => void;
  onRejected?: () => void;
}): Promise<void> {
  const {
    event,
    slack,
    userId,
    teamId,
    apiBaseUrl,
    activeTasks = [],
    resolveActiveTasks,
    launchTask,
    directedAtRoomote = false,
    roomoteSlackUserId,
    peerConversationsExperimentEnabled = false,
    userInitiated = true,
  } = params;
  const threadId = event.thread_ts || event.ts;
  const incomingConversation = {
    surface: 'slack' as const,
    workspaceId: teamId,
    conversationId: threadId,
    replyTarget: {
      channelId: event.channel,
      threadId,
    },
  };
  const releaseFastAgentLock = await acquireFastAgentTurnLock({
    conversation: incomingConversation,
    maxWaitMs: 0,
  });

  const baseQuestion = (event.authoredText ?? event.text).trim();
  const isDirected =
    directedAtRoomote ||
    event.channel_type === 'im' ||
    event.channel_type === 'mpim' ||
    mentionsSlackBot(event, roomoteSlackUserId);
  const eligibleAmbientHumanMessage =
    !isDirected &&
    Boolean(event.user) &&
    !event.bot_id &&
    event.subtype !== 'bot_message' &&
    event.user !== roomoteSlackUserId &&
    event.channel_type !== 'im' &&
    event.channel_type !== 'mpim';
  const eligiblePeerConversationMessage =
    peerConversationsExperimentEnabled &&
    Boolean(roomoteSlackUserId) &&
    eligibleAmbientHumanMessage;
  const currentMessagePeerDirected =
    eligiblePeerConversationMessage &&
    mentionsSlackUserOtherThanBotOrUser(event, roomoteSlackUserId, event.user);

  // Every Slack round trip from the control plane costs a few hundred
  // milliseconds. Start the thread history lookup as soon as the turn is
  // serialized so it overlaps with session resolution.
  const threadContextPromise: Promise<
    Awaited<ReturnType<typeof slack.fetchThreadMessages>>
  > = slack
    .fetchThreadMessages({
      channel: event.channel,
      threadTs: threadId,
    })
    .catch((error: unknown) => {
      console.error(
        `[SlackWebhook] Failed to fetch thread context for fast agent: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    });

  let releaseCanonicalFastAgentLock: Awaited<
    ReturnType<typeof acquireFastAgentTurnLock>
  > = null;

  try {
    // Resolve route-based aliases only after serializing the inbound Slack
    // thread. Delayed automation roots retain their original conversation
    // identity, so their canonical session has a separate turn lock.
    const releaseRootBindingLock = await acquireSlackFastRootBindingLock({
      teamId,
      channelId: event.channel,
    });
    const session = await (async () => {
      try {
        return await getOrCreateFastAgentSession({
          userId,
          conversation: incomingConversation,
          ...(userInitiated
            ? {
                userInitiated: {
                  surface: 'slack' as const,
                  trigger: 'message' as const,
                },
              }
            : {}),
          ...(params.originSessionId
            ? { sessionId: params.originSessionId }
            : {}),
        });
      } finally {
        await releaseRootBindingLock().catch(() => {});
      }
    })();
    const conversation = session.conversation;

    const threadContext = await threadContextPromise;

    let didSendVisibleResponse = false;
    const currentMessage = threadContext.find(
      (message) => message.ts === event.ts,
    );
    // The copy of this message returned by conversations.replies is the
    // full message object, attachments and blocks included; the webhook
    // event is a slimmer projection whose exact shape Slack does not
    // document. Add the context derived from the fetched copy unless the
    // event's own context already carries it. The event context is kept
    // regardless: entry routes (configured channels) prepend instructions
    // to it that no message fetch can reconstruct.
    const fetchedMessageContext = currentMessage
      ? formatSlackAttachmentContext(
          baseQuestion,
          currentMessage.attachments,
          currentMessage.blocks,
        )
      : undefined;
    const currentMessageContext =
      [
        event.agentContext,
        fetchedMessageContext &&
        !event.agentContext?.includes(fetchedMessageContext)
          ? fetchedMessageContext
          : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n') || undefined;
    const previousThreadMessages = threadContext.filter(
      (message) => message.ts !== event.ts,
    );
    const roomoteStartedThread =
      previousThreadMessages[0]?.user === roomoteSlackUserId;
    const roomoteWasLastSpeaker =
      previousThreadMessages.at(-1)?.user === roomoteSlackUserId;
    const previousMessageFromSender = [...previousThreadMessages]
      .reverse()
      .find(
        (message) =>
          !message.bot_id &&
          Boolean(message.user) &&
          message.user === event.user,
      );
    const previousSenderMessageWasPeerDirected = Boolean(
      previousMessageFromSender &&
      mentionsSlackUserOtherThanBotOrUser(
        previousMessageFromSender,
        roomoteSlackUserId,
        previousMessageFromSender.user,
      ),
    );
    const recentHistoryAddressedAnotherHuman = previousThreadMessages
      .slice(-PEER_CONTINUATION_HISTORY_LIMIT)
      .some(
        (message) =>
          !message.bot_id &&
          Boolean(message.user) &&
          mentionsSlackUserOtherThanBotOrUser(
            message,
            roomoteSlackUserId,
            message.user,
          ),
      );
    // An explicit current peer mention remains authoritative after a Roomote
    // reply. Only history-derived carryover yields to Roomote's latest reply;
    // Roomote-authored thread roots remain direct conversations throughout.
    const continuesPeerConversation =
      eligiblePeerConversationMessage &&
      !mentionsAnySlackUser(event) &&
      !roomoteWasLastSpeaker &&
      (previousSenderMessageWasPeerDirected ||
        recentHistoryAddressedAnotherHuman);
    const peerDirectedTurn =
      !roomoteStartedThread &&
      (currentMessagePeerDirected || continuesPeerConversation);
    const peerDirectedContext =
      peerDirectedTurn && currentMessagePeerDirected
        ? PEER_DIRECTED_CURRENT_MESSAGE_CONTEXT
        : peerDirectedTurn
          ? PEER_DIRECTED_CONTINUATION_CONTEXT
          : undefined;
    const agentContext = peerDirectedContext
      ? [currentMessageContext, peerDirectedContext]
          .filter(Boolean)
          .join('\n\n')
      : currentMessageContext;
    const currentMessageFiles = resolveCurrentSlackMessageFiles({
      currentMessageTs: event.ts,
      eventFiles: event.files,
      messages: threadContext,
    });
    const [attachments, footerContext] = await Promise.all([
      processSlackAttachments({
        slack,
        files: currentMessageFiles,
        userId,
        userTextContext: baseQuestion,
      }),
      resolveFastSessionReplyFooterContext({ sessionId: session.id }),
    ]);
    const attachmentTexts = [
      ...attachments.attachmentTexts,
      ...attachments.videoDescriptions,
    ];
    const question = appendAttachmentTextsToPromptText({
      text: baseQuestion,
      attachmentTexts,
    });
    const serializedThreadContext = previousThreadMessages.map((message) => ({
      user: message.user,
      username: message.username,
      text: message.text,
      ts: message.ts,
      bot_id: message.bot_id,
    }));
    const hasOtherHumanParticipant = threadContext.some(
      (message) =>
        message.ts !== event.ts &&
        !message.bot_id &&
        Boolean(message.user) &&
        message.user !== event.user,
    );
    const allowSilentAmbientReply =
      eligibleAmbientHumanMessage &&
      !roomoteStartedThread &&
      (peerDirectedTurn ||
        (!roomoteWasLastSpeaker && hasOtherHumanParticipant));

    const needsCanonicalAdmission =
      !releaseFastAgentLock ||
      conversation.surface !== incomingConversation.surface ||
      conversation.workspaceId !== incomingConversation.workspaceId ||
      conversation.conversationId !== incomingConversation.conversationId;
    const humanFollowUpEvent = {
      type: 'human_follow_up' as const,
      eventId: event.ts,
      currentMessageId: event.ts,
      userId,
      question,
      ...(agentContext ? { agentContext } : {}),
      ...(attachments.images.length ? { images: attachments.images } : {}),
      ...(currentMessage?.username
        ? { senderDisplayName: currentMessage.username }
        : {}),
      ...(event.user ? { senderExternalId: event.user } : {}),
      directedAtRoomote: isDirected,
      allowSilentAmbientReply,
      ...(peerDirectedTurn ? { peerDirectedTurn: true } : {}),
      ...(params.originSessionId
        ? { deliveryConversation: incomingConversation }
        : {}),
    };
    let durableTurn: FastAgentDurableTurn | null = null;
    if (needsCanonicalAdmission) {
      const admission = await admitFastAgentHumanFollowUp({
        parent: { sessionId: session.id, conversation },
        event: humanFollowUpEvent,
      });
      if (admission.kind !== 'turn') {
        params.onAccepted?.(admission.abort);
        return;
      }
      releaseCanonicalFastAgentLock = admission.turnLock;
      durableTurn = admission.durable;
    }
    const activeTurnLock =
      releaseCanonicalFastAgentLock ?? releaseFastAgentLock;
    if (!activeTurnLock) {
      params.onRejected?.();
      return;
    }
    wakeFastAgentParentEventsOnTurnRelease(activeTurnLock, session.id);
    // Durable admission: the turn is persisted under this process's claim
    // before it runs, so an interruption hands it to the queue.
    durableTurn ??= await persistFastAgentInlineHumanTurn({
      parent: { sessionId: session.id, conversation },
      event: humanFollowUpEvent,
    }).catch((error) => {
      console.error(
        `[SlackWebhook] Failed to persist Fast turn admission: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (durableTurn) {
      activeTurnLock.durableRowId = durableTurn.id;
      activeTurnLock.durableResume = () =>
        wakeFastAgentParentEventNow({
          conversationId: session.id,
          eventKey: durableTurn.eventKey,
        });
    }
    params.onAccepted?.(() =>
      activeTurnLock.abort(
        new Error('Fast suggestion launch settlement failed.'),
      ),
    );
    // Resolving reply tasks claims pending PR-review actions for this turn,
    // so it must wait until the turn is actually admitted: a steered or
    // queued follow-up must not consume actions it will never carry.
    const resolvedActiveTasks = resolveActiveTasks
      ? await resolveActiveTasks()
      : activeTasks;
    const responseText = await answerFastAgentQuestion({
      question,
      images: attachments.images,
      attachmentTexts,
      currentMessageAgentContext: agentContext,
      threadContext: serializedThreadContext,
      userId,
      apiBaseUrl,
      conversation: params.originSessionId
        ? incomingConversation
        : conversation,
      ...(params.originSessionId
        ? { canonicalConversation: conversation }
        : {}),
      currentMessageId: event.ts,
      signal: activeTurnLock.signal,
      ...(durableTurn ? { durableAdmission: { eventId: durableTurn.id } } : {}),
      // A redelivered event whose earlier inline attempt never settled
      // resumes that attempt instead of repeating its recorded actions.
      ...(durableTurn?.resumed ? { resumedAfterInterruption: true } : {}),
      senderExternalId: event.user,
      senderDisplayName:
        currentMessage?.user === event.user
          ? currentMessage.username
          : undefined,
      activeTasks: resolvedActiveTasks,
      directedAtRoomote: isDirected,
      allowSilentAmbientReply,
      peerDirectedTurn,
      ...(roomoteSlackUserId ? { slackRoomoteUserId: roomoteSlackUserId } : {}),
      adapter: {
        createArtifact: (artifact) =>
          createFastAgentConversationArtifact({
            fastConversationId: session.id,
            ...artifact,
          }),
        ...(durableTurn
          ? {
              requestDurableResume: () =>
                wakeFastAgentParentEventNow({
                  conversationId: session.id,
                  eventKey: durableTurn.eventKey,
                }),
              requestDurableRetry: (retryAt: Date) =>
                wakeFastAgentParentEventAt(
                  {
                    conversationId: session.id,
                    eventKey: durableTurn.eventKey,
                  },
                  retryAt,
                ),
            }
          : {}),
        activity: createFastAgentSlackSessionActivity({
          slack,
          workspaceId: teamId,
          channel: event.channel,
          threadTs: threadId,
          title: session.title,
          resolveTitle: async () =>
            (await fastAgentConversationRepository.findById({ id: session.id }))
              ?.title,
        }),
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        launchTask,
        ...(event.user
          ? {
              createReplyStream: () =>
                guardReplyStreamBySourceMessage(
                  createSlackFastReplyStream({
                    slack,
                    conversation,
                    channelId: event.channel,
                    threadTs: threadId,
                    recipientTeamId: teamId,
                    recipientUserId: event.user,
                    sessionId: session.id,
                    footerContext,
                    resolveImages: (artifactIds) =>
                      resolveFastAgentSessionImages({
                        artifactIds,
                        sessionId: session.id,
                      }),
                    onDelivered: () => {
                      didSendVisibleResponse = true;
                    },
                  }),
                  {
                    slack,
                    channel: event.channel,
                    threadTs: threadId,
                    sourceMessageTs: event.ts,
                  },
                ),
            }
          : {}),
        postReply: async ({
          message,
          kickoff,
          imageArtifactIds = [],
          videoArtifactIds = [],
          charts = [],
        }) => {
          const replyImages = await resolveFastAgentSessionImages({
            artifactIds: imageArtifactIds,
            sessionId: session.id,
          });
          const posted = await postSlackThreadMarkdownMessage({
            slack,
            channel: event.channel,
            threadTs: threadId,
            text: message,
            charts,
            sourceMessageTs: event.ts,
            deliverVideos: videoArtifactIds.length
              ? () =>
                  deliverFastAgentSessionVideos({
                    artifactIds: videoArtifactIds,
                    sessionId: session.id,
                    channelId: event.channel,
                    threadTs: threadId,
                  })
              : undefined,
            conversationLog: {
              userId,
              slackTeamId: teamId,
              source: 'fast_agent',
            },
            fastSessionFooter: { sessionId: session.id, ...footerContext },
            images: replyImages.map((image) => ({
              url: image.url,
              altText: image.altText,
            })),
          });
          if (posted === 'failed') {
            throw new Error('Slack did not accept the Fast parent reply.');
          }
          if (posted === 'suppressed' && kickoff) {
            // The launch gate requires a visible, durable parent kickoff
            // before the child becomes runnable; a suppressed kickoff must
            // abort the launch instead of opening the gate silently.
            throw new Error(
              'The Fast kickoff was suppressed because the triggering message was deleted.',
            );
          }
          // Suppression of an ordinary reply is deliberate (the triggering
          // message was deleted); treat it as delivered so the turn is not
          // aborted mid-flight.
          didSendVisibleResponse = true;
          if (typeof posted !== 'object') {
            return undefined;
          }
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: posted.messageId,
          });
          return { messageId: posted.messageId };
        },
        replaceReply: async ({ messageId }, { message, charts }) => {
          // Keep the sticky footer when the edited message is its current
          // carrier; the lookup and edit share the footer lock so a
          // concurrent relocation cannot slip in between them.
          const updated = await withSlackThreadReplyFooterLock({
            channel: event.channel,
            threadTs: threadId,
            fn: async () => {
              const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
                event.channel,
                threadId,
              ).catch(() => null);
              return slack.updateMessage({
                channel: event.channel,
                ts: messageId,
                message: {
                  text: message,
                  blocks: [
                    { type: 'markdown', text: message },
                    ...buildDataVisualizationBlocks(charts),
                    ...(footerMessageTs === messageId
                      ? [
                          buildSlackThreadReplyFooterBlock({
                            footerText: buildFastSessionReplyFooterText({
                              provider: 'slack',
                              sessionId: session.id,
                              ...footerContext,
                            }),
                          }),
                        ]
                      : []),
                  ],
                },
              });
            },
          });
          if (!updated) {
            throw new Error('Slack did not update the Fast parent reply.');
          }
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId,
          });
          didSendVisibleResponse = true;
          return { messageId };
        },
        postReaction: async ({ name, messageId }) => {
          const added = await slack.addReaction({
            channel: event.channel,
            timestamp: messageId,
            name,
          });
          if (!added) {
            throw new Error(`Slack rejected the ${name} reaction.`);
          }
          didSendVisibleResponse = true;
        },
      },
    });

    if (responseText.length > 0 && !didSendVisibleResponse) {
      const posted = await postSlackThreadMarkdownMessage({
        slack,
        channel: event.channel,
        threadTs: threadId,
        text: responseText,
        sourceMessageTs: event.ts,
        conversationLog: {
          userId,
          slackTeamId: teamId,
          source: 'fast_agent',
        },
        fastSessionFooter: { sessionId: session.id, ...footerContext },
      });
      if (typeof posted === 'object') {
        await recordFastAgentConversationMessageBestEffort({
          sessionId: session.id,
          conversation,
          messageId: posted.messageId,
        });
      }
    }
  } finally {
    await releaseCanonicalFastAgentLock?.().catch(() => {});
    await releaseFastAgentLock?.().catch(() => {});
  }
}
