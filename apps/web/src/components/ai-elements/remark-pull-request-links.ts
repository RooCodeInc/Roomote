import type { Link, PhrasingContent, Root, Text } from 'mdast';
import type { Parent } from 'unist';
import { SKIP, visit } from 'unist-util-visit';

const PULL_REQUEST_MENTION_PATTERN = /\bPR #([1-9]\d*)\b/g;

export function remarkPullRequestLinks(repositoryUrl: string) {
  const baseUrl = repositoryUrl.replace(/\/$/u, '');

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

        const children: PhrasingContent[] = [];
        let lastIndex = 0;

        for (const match of node.value.matchAll(PULL_REQUEST_MENTION_PATTERN)) {
          const matchIndex = match.index;
          const pullRequestNumber = match[1];
          if (matchIndex === undefined || !pullRequestNumber) continue;

          if (matchIndex > lastIndex) {
            children.push({
              type: 'text',
              value: node.value.slice(lastIndex, matchIndex),
            });
          }

          children.push({
            type: 'link',
            url: `${baseUrl}/pull/${pullRequestNumber}`,
            children: [{ type: 'text', value: match[0] }],
          } satisfies Link);
          lastIndex = matchIndex + match[0].length;
        }

        if (children.length === 0) return;
        if (lastIndex < node.value.length) {
          children.push({ type: 'text', value: node.value.slice(lastIndex) });
        }

        parent.children.splice(index, 1, ...children);
        return [SKIP, index + children.length] as const;
      },
    );
  };
}
