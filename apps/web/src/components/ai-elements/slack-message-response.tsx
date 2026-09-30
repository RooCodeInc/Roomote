'use client';

import type { ComponentProps } from 'react';
import type { Node } from 'unist';
import { defaultRehypePlugins } from 'streamdown';
import { parseSlackMessageTokens } from '@roomote/types';

import { CustomLink } from './custom-link';
import { CustomParagraph, MessageResponse } from './message';
import { SlackMessageText } from './slack-message-text';

// The small structural subset shared by HAST root, element, and text nodes.
type MarkdownNode = Node & {
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
};

const PROTECTED_ELEMENTS = new Set(['a', 'code', 'pre', 'img', 'button']);

function rehypeSlackReferences() {
  return (tree: MarkdownNode) => {
    function transform(node: MarkdownNode) {
      if (node.tagName && PROTECTED_ELEMENTS.has(node.tagName)) return;
      if (!node.children) return;

      node.children = node.children.map((child) => {
        if (
          child.type === 'text' &&
          child.value &&
          parseSlackMessageTokens(child.value).some(
            (token) => token.type !== 'text',
          )
        ) {
          return {
            type: 'element',
            tagName: 'span',
            properties: { 'data-slack-reference': true },
            children: [child],
          };
        }
        transform(child);
        return child;
      });
    }
    transform(tree);
  };
}

function SlackReferenceSpan({
  children,
  node: _node,
  'data-slack-reference': isSlackReference,
  ...props
}: ComponentProps<'span'> & {
  node?: Node;
  'data-slack-reference'?: boolean;
}) {
  if (isSlackReference && typeof children === 'string') {
    return <SlackMessageText text={children} />;
  }
  return <span {...props}>{children}</span>;
}

// Run after Streamdown's sanitization, preserving its default renderers and
// code/diagram plugins. Only eligible text leaves subscribe to Slack names.
const rehypePlugins = [
  ...Object.values(defaultRehypePlugins),
  rehypeSlackReferences,
];
const components = {
  a: CustomLink,
  p: CustomParagraph,
  span: SlackReferenceSpan,
};

export function SlackMessageResponse({ text }: { text: string }) {
  return (
    <MessageResponse components={components} rehypePlugins={rehypePlugins}>
      {text}
    </MessageResponse>
  );
}
