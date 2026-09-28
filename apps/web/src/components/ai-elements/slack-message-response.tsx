'use client';

import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import { CustomLink } from './custom-link';
import { MessageResponse } from './message';
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

type MarkdownNodeProps = {
  node?: { tagName?: string; position?: unknown };
};

function createSlackMarkdownElement<Tag extends keyof JSX.IntrinsicElements>(
  tag: Tag,
) {
  return function SlackMarkdownElement(
    props: ComponentProps<Tag> & MarkdownNodeProps,
  ) {
    const { children, node: _node, ...rest } = props;
    const className =
      tag === 'p'
        ? cn('min-w-0 [overflow-wrap:anywhere]', rest.className)
        : rest.className;

    return createElement(
      tag,
      { ...rest, className } as Record<string, unknown>,
      renderSlackTextChildren(children),
    );
  };
}

const SlackMarkdownHeading1 = createSlackMarkdownElement('h1');
const SlackMarkdownHeading2 = createSlackMarkdownElement('h2');
const SlackMarkdownHeading3 = createSlackMarkdownElement('h3');
const SlackMarkdownHeading4 = createSlackMarkdownElement('h4');
const SlackMarkdownHeading5 = createSlackMarkdownElement('h5');
const SlackMarkdownHeading6 = createSlackMarkdownElement('h6');
const SlackMarkdownListItem = createSlackMarkdownElement('li');
const SlackMarkdownParagraph = createSlackMarkdownElement('p');

/** Renders assistant Markdown with Slack references at the parsed-node boundary. */
export function SlackMessageResponse({ text }: { text: string }) {
  return (
    <MessageResponse
      components={{
        a: CustomLink,
        code: 'code',
        h1: SlackMarkdownHeading1,
        h2: SlackMarkdownHeading2,
        h3: SlackMarkdownHeading3,
        h4: SlackMarkdownHeading4,
        h5: SlackMarkdownHeading5,
        h6: SlackMarkdownHeading6,
        li: SlackMarkdownListItem,
        p: SlackMarkdownParagraph,
        pre: 'pre',
      }}
    >
      {text}
    </MessageResponse>
  );
}
