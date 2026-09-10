import {
  buildDataVisualizationBlocks,
  type DataVisualizationInput,
  type SlackBlock,
} from '@roomote/types';

import { ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID } from '@roomote/slack';

const MAX_SLACK_REPLY_BODY_BLOCKS = 49;

export function buildFastAgentSlackReplyBodyBlocks(params: {
  message: string;
  quote?: string | null;
  charts?: DataVisualizationInput[];
  images?: Array<{ url: string; altText: string }>;
}): SlackBlock[] {
  const leadingBlocks = [
    ...(params.quote
      ? [
          {
            type: 'section' as const,
            block_id: ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
            text: { type: 'mrkdwn' as const, text: params.quote },
          },
        ]
      : []),
    { type: 'markdown' as const, text: params.message },
    ...buildDataVisualizationBlocks(params.charts),
  ];
  const imageCapacity = Math.max(
    0,
    MAX_SLACK_REPLY_BODY_BLOCKS - leadingBlocks.length,
  );

  return [
    ...leadingBlocks,
    ...(params.images ?? []).slice(0, imageCapacity).map((image) => ({
      type: 'image' as const,
      image_url: image.url,
      alt_text: image.altText,
    })),
  ];
}
