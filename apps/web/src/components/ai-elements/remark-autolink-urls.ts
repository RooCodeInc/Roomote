import { SKIP, visit } from 'unist-util-visit';
// `Parent` comes from `unist` instead of `mdast` so the visitor signatures stay
// compatible with third-party `mdast` type augmentations.
import type { Node as UnistNode, Parent } from 'unist';
import type { Link, PhrasingContent, Root, RootContent, Text } from 'mdast';

const URL_PATTERN = /\b(?:https?:\/\/|mailto:|tel:)[^\s<]+/g;

const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

function trimUnmatchedTrailingClosers(value: string): string {
  let next = value;

  while (next.length > 0) {
    const lastChar = next.at(-1);

    if (!lastChar || !')]}'.includes(lastChar)) {
      return next;
    }

    const opener = lastChar === ')' ? '(' : lastChar === ']' ? '[' : '{';
    const openCount = [...next].filter((char) => char === opener).length;
    const closeCount = [...next].filter((char) => char === lastChar).length;

    if (closeCount <= openCount) {
      return next;
    }

    next = next.slice(0, -1);
  }

  return next;
}

function normalizeMatchedUrl(value: string): string {
  let next = value;
  let previous = '';

  while (next !== previous) {
    previous = next;
    next = next.replace(TRAILING_PUNCTUATION, '');
    next = trimUnmatchedTrailingClosers(next);
  }

  return next;
}

function shouldSkipParent(parent: Parent | undefined): boolean {
  if (!parent || typeof parent.type !== 'string') {
    return true;
  }

  return (
    parent.type === 'link' ||
    parent.type === 'linkReference' ||
    parent.type === 'definition' ||
    parent.type === 'image' ||
    parent.type === 'imageReference'
  );
}

function isMarkdownLinkSyntax(
  value: string,
  matchIndex: number,
  rawUrl: string,
): boolean {
  const previousChar = value.at(matchIndex - 1);
  const followingText = value.slice(matchIndex + rawUrl.length);

  return (
    previousChar === '[' &&
    (rawUrl.includes('](') ||
      rawUrl.includes('][') ||
      rawUrl.includes(']:') ||
      followingText.startsWith('](') ||
      followingText.startsWith('][') ||
      followingText.startsWith(']:'))
  );
}

function buildReplacementNodes(value: string): Array<PhrasingContent | Text> {
  const nodes: Array<PhrasingContent | Text> = [];
  let lastIndex = 0;

  for (const match of value.matchAll(URL_PATTERN)) {
    const rawUrl = match[0];
    const matchIndex = match.index;

    if (rawUrl === undefined || matchIndex === undefined) {
      continue;
    }

    if (isMarkdownLinkSyntax(value, matchIndex, rawUrl)) {
      continue;
    }

    const normalizedUrl = normalizeMatchedUrl(rawUrl);

    if (!normalizedUrl) {
      continue;
    }

    if (matchIndex > lastIndex) {
      nodes.push({
        type: 'text',
        value: value.slice(lastIndex, matchIndex),
      });
    }

    const trailingText = rawUrl.slice(normalizedUrl.length);

    nodes.push({
      type: 'link',
      url: normalizedUrl,
      children: [{ type: 'text', value: normalizedUrl }],
    } satisfies Link);

    if (trailingText) {
      nodes.push({ type: 'text', value: trailingText });
    }

    lastIndex = matchIndex + rawUrl.length;
  }

  if (lastIndex === 0) {
    return [];
  }

  if (lastIndex < value.length) {
    nodes.push({
      type: 'text',
      value: value.slice(lastIndex),
    });
  }

  return nodes;
}

function isTextNode(node: UnistNode): node is Text {
  return node.type === 'text';
}

function hasMarkdownLinkContinuation(value: string): boolean {
  return (
    value.startsWith('](') || value.startsWith('][') || value.startsWith(']:')
  );
}

function isAccidentalMarkdownishAutolink(
  node: Link,
  index: number,
  parent: Parent,
): boolean {
  const previousSibling = parent.children[index - 1];
  const nextSibling = parent.children[index + 1];
  const linkText = node.children
    .map((child) => ('value' in child ? child.value : ''))
    .join('');

  const previousEndsMarkdownOpen =
    previousSibling && isTextNode(previousSibling)
      ? previousSibling.value.endsWith('[')
      : false;
  const nextStartsMarkdownContinuation =
    nextSibling && isTextNode(nextSibling)
      ? hasMarkdownLinkContinuation(nextSibling.value)
      : false;

  return (
    previousEndsMarkdownOpen &&
    (linkText.includes('][') ||
      linkText.includes('](') ||
      linkText.includes(']:') ||
      nextStartsMarkdownContinuation)
  );
}

/**
 * Autolinks plain absolute URLs while leaving existing markdown links untouched.
 */
export function remarkAutolinkUrls() {
  return (tree: Root) => {
    visit(
      tree,
      'text',
      (node: Text, index: number | undefined, parent: Parent | undefined) => {
        if (index === undefined || !parent || shouldSkipParent(parent)) {
          return;
        }

        const replacementNodes = buildReplacementNodes(node.value);

        if (replacementNodes.length === 0) {
          return;
        }

        (parent.children as RootContent[]).splice(
          index,
          1,
          ...replacementNodes,
        );

        return [SKIP, index + replacementNodes.length] as const;
      },
    );

    visit(
      tree,
      'link',
      (node: Link, index: number | undefined, parent: Parent | undefined) => {
        if (index === undefined || !parent) {
          return;
        }

        if (!isAccidentalMarkdownishAutolink(node, index, parent)) {
          return;
        }

        const replacementText: Text = {
          type: 'text',
          value: node.children
            .map((child) => ('value' in child ? child.value : ''))
            .join(''),
        };
        parent.children.splice(index, 1, replacementText);

        return [SKIP, index] as const;
      },
    );
  };
}
