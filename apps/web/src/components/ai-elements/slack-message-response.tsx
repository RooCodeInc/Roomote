'use client';

import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from 'react';

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

function SlackMarkdownParagraph(props: ComponentProps<typeof CustomParagraph>) {
  return (
    <CustomParagraph {...props}>
      {renderSlackTextChildren(props.children)}
    </CustomParagraph>
  );
}

/** Renders assistant Markdown with Slack references at the parsed-node boundary. */
export function SlackMessageResponse({ text }: { text: string }) {
  return (
    <MessageResponse
      components={{
        a: CustomLink,
        code: 'code',
        p: SlackMarkdownParagraph,
        pre: 'pre',
      }}
    >
      {text}
    </MessageResponse>
  );
}
