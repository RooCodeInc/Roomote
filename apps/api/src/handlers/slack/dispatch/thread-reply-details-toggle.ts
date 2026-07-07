import {
  and,
  db,
  eq,
  slackInstallations,
  taskSlackReplyDetails,
} from '@roomote/db/server';
import {
  buildRoomoteSlackReplyBlocks,
  buildRoomoteSlackReplyFallbackText,
  clearSlackThreadReplyFooterMessageTs,
  getLatestSlackBotReply,
  getSlackThreadReplyFooterMessageTs,
  parseRoomoteSlackReplyToggleValue,
  ROOMOTE_SLACK_REPLY_ACTIONS_BLOCK_ID,
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
  setLatestSlackBotReply,
  setSlackThreadReplyFooterMessageTs,
  SlackNotifier,
  trackSlackBotReply,
  type RoomoteSlackReplyDetailRecord,
  type SlackInteractivePayload,
} from '@roomote/slack';

const SLACK_THREAD_REPLY_FOOTER_BLOCK_ID = 'roomote_thread_reply_footer';
const SLACK_MAX_MESSAGE_BLOCKS = 50;
const TOGGLE_DETAIL_MISSING_TEXT = 'Those details are no longer available.';
const TOGGLE_RELOAD_ERROR_TEXT =
  "I couldn't reload that reply just now. Please try again.";
const TOGGLE_UPDATE_ERROR_TEXT =
  "I couldn't update that reply just now. Please try again.";

async function findSlackReplyDetailRecord(params: {
  taskId: string;
  detailId: string;
}): Promise<RoomoteSlackReplyDetailRecord | null> {
  const persistedMatch = await db.query.taskSlackReplyDetails.findFirst({
    columns: {
      summary: true,
      findings: true,
    },
    where: and(
      eq(taskSlackReplyDetails.taskId, params.taskId),
      eq(taskSlackReplyDetails.detailId, params.detailId),
    ),
  });

  if (!persistedMatch || persistedMatch.findings.length === 0) {
    return null;
  }

  return {
    taskId: params.taskId,
    detailId: params.detailId,
    ...(persistedMatch.summary && { summary: persistedMatch.summary }),
    findings: persistedMatch.findings,
  };
}

function isSlackFooterBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  return (
    (block as { block_id?: unknown }).block_id ===
    SLACK_THREAD_REPLY_FOOTER_BLOCK_ID
  );
}

function isSlackImageBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  return (block as { type?: unknown }).type === 'image';
}

function hasSlackFooterBlock(blocks: unknown[]): boolean {
  return blocks.some(isSlackFooterBlock);
}

function isRoomoteActionsBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  return (
    (block as { block_id?: unknown }).block_id ===
    ROOMOTE_SLACK_REPLY_ACTIONS_BLOCK_ID
  );
}

function getLastMatchingBlockIndex(
  blocks: unknown[],
  predicate: (block: unknown) => boolean,
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (predicate(blocks[index])) {
      return index;
    }
  }

  return -1;
}

function buildUpdatedReplyBlocks(params: {
  existingBlocks: unknown[];
  summary?: string;
  findings: string[];
  taskId: string;
  detailId: string;
  expanded: boolean;
}): unknown[] {
  if (params.existingBlocks.length === 0) {
    return buildRoomoteSlackReplyBlocks({
      taskId: params.taskId,
      detailId: params.detailId,
      summary: params.summary,
      findings: params.findings,
      expanded: params.expanded,
      maxBlocks: SLACK_MAX_MESSAGE_BLOCKS,
    });
  }

  const footerIndex = getLastMatchingBlockIndex(
    params.existingBlocks,
    isSlackFooterBlock,
  );
  const actionsIndex = getLastMatchingBlockIndex(
    params.existingBlocks,
    isRoomoteActionsBlock,
  );

  if (actionsIndex === -1) {
    return buildRoomoteSlackReplyBlocks({
      taskId: params.taskId,
      detailId: params.detailId,
      summary: params.summary,
      findings: params.findings,
      expanded: params.expanded,
      maxBlocks: SLACK_MAX_MESSAGE_BLOCKS,
    });
  }

  const footerBlocks =
    footerIndex === -1 ? [] : [params.existingBlocks[footerIndex]];
  const suffixBlocks =
    footerIndex === -1 ? [] : params.existingBlocks.slice(footerIndex + 1);

  const quoteIndex = (() => {
    for (let index = actionsIndex - 1; index >= 0; index -= 1) {
      const block = params.existingBlocks[index];
      if (
        (block as { block_id?: unknown }).block_id ===
        ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID
      ) {
        return index;
      }
    }

    return -1;
  })();

  const prefixBlocks =
    quoteIndex === -1 ? [] : params.existingBlocks.slice(0, quoteIndex);
  const quoteBlocks =
    quoteIndex === -1 ? [] : [params.existingBlocks[quoteIndex]];

  const trailingImageBlocks: unknown[] = [];
  const trailingRangeEnd =
    footerIndex === -1 ? params.existingBlocks.length : footerIndex;
  for (let index = actionsIndex + 1; index < trailingRangeEnd; index += 1) {
    const block = params.existingBlocks[index];
    if (isSlackImageBlock(block)) {
      trailingImageBlocks.push(block);
    }
  }
  const maxContentBlocks = Math.max(
    0,
    SLACK_MAX_MESSAGE_BLOCKS -
      prefixBlocks.length -
      quoteBlocks.length -
      trailingImageBlocks.length -
      footerBlocks.length -
      suffixBlocks.length,
  );
  const nextContentBlocks = buildRoomoteSlackReplyBlocks({
    taskId: params.taskId,
    detailId: params.detailId,
    summary: params.summary,
    findings: params.findings,
    expanded: params.expanded,
    maxBlocks: maxContentBlocks,
  });

  return [
    ...prefixBlocks,
    ...quoteBlocks,
    ...nextContentBlocks,
    ...trailingImageBlocks,
    ...footerBlocks,
    ...suffixBlocks,
  ];
}

async function postToggleErrorResponse(params: {
  responseUrl: string;
  text: string;
}): Promise<void> {
  try {
    await fetch(params.responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        replace_original: false,
        text: params.text,
      }),
    });
  } catch (error) {
    console.warn(
      `[ThreadReplyDetailsToggle] Failed to post Slack error response: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function resolveThreadTs(params: {
  payload: SlackInteractivePayload;
  slack: SlackNotifier;
}): Promise<string | null> {
  const directThreadTs =
    params.payload.message.thread_ts?.trim() ||
    params.payload.container?.thread_ts?.trim();

  if (directThreadTs) {
    return directThreadTs;
  }

  const message = await params.slack.getMessage({
    channel: params.payload.channel.id,
    messageTs: params.payload.message.ts,
  });

  if (message?.thread_ts) {
    return message.thread_ts;
  }

  if (message?.ts === params.payload.message.ts) {
    return params.payload.message.ts;
  }

  return null;
}

async function syncReplacedReplyTracking(params: {
  channel: string;
  threadTs: string;
  previousMessageTs: string;
  nextMessageTs: string;
  text: string;
  blocks: unknown[];
}): Promise<void> {
  const hasFooter = hasSlackFooterBlock(params.blocks);

  try {
    await trackSlackBotReply(
      params.channel,
      params.threadTs,
      params.nextMessageTs,
    );
  } catch (error) {
    console.warn(
      `[ThreadReplyDetailsToggle] Failed to mark replacement Slack reply ${params.nextMessageTs} as delivered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const latestReply = await getLatestSlackBotReply(
      params.channel,
      params.threadTs,
    );

    if (latestReply?.ts === params.previousMessageTs) {
      await setLatestSlackBotReply(
        params.channel,
        params.threadTs,
        params.nextMessageTs,
        params.text,
        latestReply.outOfBand ? { outOfBand: true } : undefined,
      );
    }
  } catch (error) {
    console.warn(
      `[ThreadReplyDetailsToggle] Failed to update latest Slack bot reply tracking for replacement ${params.previousMessageTs} -> ${params.nextMessageTs}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
      params.channel,
      params.threadTs,
    );

    if (footerMessageTs === params.previousMessageTs) {
      if (hasFooter) {
        await setSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
          params.nextMessageTs,
        );
      } else {
        await clearSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[ThreadReplyDetailsToggle] Failed to update footer tracking for replacement ${params.previousMessageTs} -> ${params.nextMessageTs}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function replaceThreadReply(params: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  previousMessageTs: string;
  text: string;
  blocks: unknown[];
}): Promise<boolean> {
  const nextMessageTs = await params.slack.postMessage({
    channel: params.channel,
    thread_ts: params.threadTs,
    ...(params.text ? { text: params.text } : {}),
    blocks: params.blocks,
  });

  if (!nextMessageTs) {
    return false;
  }

  await syncReplacedReplyTracking({
    channel: params.channel,
    threadTs: params.threadTs,
    previousMessageTs: params.previousMessageTs,
    nextMessageTs,
    text: params.text,
    blocks: params.blocks,
  });

  const deleted = await params.slack.deleteMessage({
    channel: params.channel,
    ts: params.previousMessageTs,
  });

  if (!deleted) {
    console.warn(
      `[ThreadReplyDetailsToggle] Failed to delete replaced Slack message ${params.previousMessageTs} after posting ${nextMessageTs}`,
    );
  }

  return true;
}

export async function handleThreadReplyDetailsToggle(
  payload: SlackInteractivePayload,
): Promise<void> {
  const toggleValue =
    payload.actions[0]?.type === 'button'
      ? parseRoomoteSlackReplyToggleValue(payload.actions[0].value)
      : null;

  if (!toggleValue) {
    console.warn(
      '[ThreadReplyDetailsToggle] Missing or invalid toggle payload; ignoring action',
    );
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    columns: { botAccessToken: true },
    where: and(
      eq(slackInstallations.teamId, payload.team.id),
      eq(slackInstallations.isActive, true),
    ),
  });

  if (!slackInstallation?.botAccessToken) {
    console.warn(
      `[ThreadReplyDetailsToggle] No active Slack installation found for team ${payload.team.id}`,
    );
    await postToggleErrorResponse({
      responseUrl: payload.response_url,
      text: TOGGLE_RELOAD_ERROR_TEXT,
    });
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const detailRecord = await findSlackReplyDetailRecord({
    taskId: toggleValue.taskId,
    detailId: toggleValue.detailId,
  });

  if (!detailRecord) {
    console.warn(
      `[ThreadReplyDetailsToggle] Could not find Slack reply detail ${toggleValue.detailId} for task ${toggleValue.taskId}`,
    );
    await postToggleErrorResponse({
      responseUrl: payload.response_url,
      text: TOGGLE_DETAIL_MISSING_TEXT,
    });
    return;
  }

  const threadTs = await resolveThreadTs({
    payload,
    slack,
  });

  if (!threadTs) {
    console.warn(
      `[ThreadReplyDetailsToggle] Could not resolve thread ts for message ${payload.message.ts} in channel ${payload.channel.id} for task ${toggleValue.taskId} detail ${toggleValue.detailId}`,
    );
    await postToggleErrorResponse({
      responseUrl: payload.response_url,
      text: TOGGLE_RELOAD_ERROR_TEXT,
    });
    return;
  }

  const expanded = !toggleValue.expanded;
  const existingBlocks = await slack.getMessageBlocks({
    channel: payload.channel.id,
    messageTs: payload.message.ts,
    threadTs,
  });

  if (existingBlocks === null) {
    console.warn(
      `[ThreadReplyDetailsToggle] Failed to load Slack blocks for message ${payload.message.ts} in thread ${threadTs} for task ${toggleValue.taskId} detail ${toggleValue.detailId}`,
    );
    await postToggleErrorResponse({
      responseUrl: payload.response_url,
      text: TOGGLE_RELOAD_ERROR_TEXT,
    });
    return;
  }

  const blocks = buildUpdatedReplyBlocks({
    existingBlocks,
    summary: detailRecord.summary,
    findings: detailRecord.findings,
    taskId: toggleValue.taskId,
    detailId: toggleValue.detailId,
    expanded,
  });
  const text =
    buildRoomoteSlackReplyFallbackText({
      summary: detailRecord.summary,
      findings: detailRecord.findings,
      expanded,
    }) ?? 'Slack reply';

  const updated = await replaceThreadReply({
    slack,
    channel: payload.channel.id,
    threadTs,
    previousMessageTs: payload.message.ts,
    text,
    blocks,
  });

  if (!updated) {
    console.warn(
      `[ThreadReplyDetailsToggle] Failed to update Slack message ${payload.message.ts} in channel ${payload.channel.id} for task ${toggleValue.taskId} detail ${toggleValue.detailId}`,
    );
    await postToggleErrorResponse({
      responseUrl: payload.response_url,
      text: TOGGLE_UPDATE_ERROR_TEXT,
    });
  }
}
