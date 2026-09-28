import type { Link, PhrasingContent, Root, Text } from 'mdast';
import type { Parent } from 'unist';
import { SKIP, visit } from 'unist-util-visit';
import { parseSlackMessageTokens } from '@roomote/types';

import type { ResolvedSlackReferences } from './slack-message-references';

function renderReference(label: string, href: string | null): PhrasingContent {
  if (!href) {
    return { type: 'text', value: label };
  }

  return {
    type: 'link',
    url: href,
    children: [{ type: 'text', value: label }],
  } satisfies Link;
}

function renderToken(
  token: ReturnType<typeof parseSlackMessageTokens>[number],
  references: ResolvedSlackReferences,
): PhrasingContent {
  switch (token.type) {
    case 'text':
      return { type: 'text', value: token.text };
    case 'user': {
      const resolved = references.users[token.userId];
      return renderReference(
        `@${resolved?.name ?? token.label ?? token.userId}`,
        resolved?.profileUrl ?? null,
      );
    }
    case 'channel': {
      const resolved = references.channels[token.channelId];
      return renderReference(
        `#${resolved?.name ?? token.label ?? token.channelId}`,
        resolved?.url ?? null,
      );
    }
    case 'usergroup':
      return renderReference(`@${token.label ?? token.usergroupId}`, null);
    case 'broadcast':
      return renderReference(`@${token.name}`, null);
    case 'link':
      return {
        type: 'text',
        value: `<${token.url}${token.label ? `|${token.label}` : ''}>`,
      };
    default:
      return { type: 'text', value: '' };
  }
}

/**
 * Converts Slack user and channel references in Markdown text nodes into
 * readable labels and links after Streamdown has parsed the Markdown. Inline
 * code, fenced code, and existing Markdown links are left untouched.
 */
export function remarkSlackMessageReferences(
  references: ResolvedSlackReferences,
) {
  return () => (tree: Root) => {
    visit(
      tree,
      'text',
      (node: Text, index: number | undefined, parent: Parent | undefined) => {
        if (
          !parent ||
          index === undefined ||
          parent.type === 'link' ||
          parent.type === 'linkReference'
        ) {
          return;
        }

        const tokens = parseSlackMessageTokens(node.value);
        if (!tokens.some((token) => token.type !== 'text')) {
          return;
        }

        const children = tokens.map((token) => renderToken(token, references));
        parent.children.splice(index, 1, ...children);
        return [SKIP, index + children.length] as const;
      },
    );
  };
}
