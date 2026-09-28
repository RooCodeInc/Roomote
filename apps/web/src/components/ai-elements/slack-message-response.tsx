'use client';

import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import { CustomLink } from './custom-link';
import { CustomParagraph, MessageResponse } from './message';
import { SlackMessageText } from './slack-message-text';

const PROTECTED_ELEMENTS = new Set(['a', 'code', 'pre', 'img', 'button']);
const RECURSIVE_ELEMENTS = new Set([
  'del',
  'em',
  'mark',
  's',
  'span',
  'strong',
]);
const TEXT_CONTAINER_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
]);

function renderSlackTextChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      return <SlackMessageText text={child} />;
    }

    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }

    if (typeof child.type === 'string' && PROTECTED_ELEMENTS.has(child.type)) {
      return child;
    }

    if (
      typeof child.type !== 'string' ||
      !RECURSIVE_ELEMENTS.has(child.type) ||
      !('children' in child.props)
    ) {
      return child;
    }

    return cloneElement(
      child,
      undefined,
      renderSlackTextChildren(child.props.children),
    );
  });
}

function SlackMarkdownTextContainer({
  children,
  node,
  ...props
}: ComponentProps<typeof CustomParagraph>) {
  const tagName = TEXT_CONTAINER_TAGS.has(node?.tagName ?? '')
    ? node?.tagName
    : 'p';
  const className =
    tagName === 'p'
      ? cn('min-w-0 [overflow-wrap:anywhere]', props.className)
      : props.className;

  return createElement(
    tagName,
    { ...props, className },
    renderSlackTextChildren(children),
  );
}

/** Renders assistant Markdown with Slack references at the parsed-node boundary. */
export function SlackMessageResponse({ text }: { text: string }) {
  return (
    <MessageResponse
      components={{
        a: CustomLink,
        code: 'code',
        h1: SlackMarkdownTextContainer,
        h2: SlackMarkdownTextContainer,
        h3: SlackMarkdownTextContainer,
        h4: SlackMarkdownTextContainer,
        h5: SlackMarkdownTextContainer,
        h6: SlackMarkdownTextContainer,
        li: SlackMarkdownTextContainer,
        p: SlackMarkdownTextContainer,
        pre: 'pre',
      }}
    >
      {text}
    </MessageResponse>
  );
}
