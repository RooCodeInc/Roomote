const CLIENT_UNSAFE_ROOT_IMPORTS = Object.freeze({
  '@roomote/auth':
    'Client-safe code must use @roomote/auth/client instead of the mixed root barrel.',
  '@roomote/env':
    'Client-safe code must not import @roomote/env directly. Thread required env through runtime plumbing instead.',
  '@roomote/github':
    'Client-safe code must not import @roomote/github directly. Route GitHub operations through existing runtime plumbing or add a client-safe export.',
  '@roomote/linear':
    'Client-safe code must use @roomote/linear/client instead of the mixed root barrel.',
  '@roomote/redis':
    'Client-safe code must not import @roomote/redis directly. Route Redis-backed operations through @roomote/sdk or add a client-safe export.',
  '@roomote/sdk':
    'Client-safe code must use @roomote/sdk/client instead of the mixed root barrel.',
  '@roomote/slack':
    'Client-safe code must use @roomote/slack/client instead of the mixed root barrel.',
});

const CLIENT_SERVER_ENTRYPOINT_RE = /^@roomote\/[^/]+\/server(?:\/.*)?$/;

function getImportSource(node) {
  if (!node || !('source' in node) || !node.source) {
    return null;
  }

  return typeof node.source.value === 'string' ? node.source.value : null;
}

const clientImportBoundaryPlugin = {
  meta: {
    name: '@roomote/config-eslint/client',
  },
  rules: {
    'no-unsafe-roomote-imports': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow worker imports from unsafe Roomote workspace package surfaces.',
        },
        schema: [],
        messages: {
          unsafeRoot: '{{message}}',
          unsafeServer:
            'Client-safe code must not import workspace server entrypoints. Route DB/Redis-backed operations through @roomote/sdk or add a client-safe export.',
        },
      },
      create(context) {
        function checkNode(node) {
          const source = getImportSource(node);

          if (!source) {
            return;
          }

          const unsafeRootMessage = CLIENT_UNSAFE_ROOT_IMPORTS[source];

          if (unsafeRootMessage) {
            context.report({
              node: node.source,
              messageId: 'unsafeRoot',
              data: { message: unsafeRootMessage },
            });

            return;
          }

          if (CLIENT_SERVER_ENTRYPOINT_RE.test(source)) {
            context.report({ node: node.source, messageId: 'unsafeServer' });
          }
        }

        return {
          ImportDeclaration: checkNode,
          ExportAllDeclaration: checkNode,
          ExportNamedDeclaration: checkNode,
          ImportExpression(node) {
            if (typeof node.source.value !== 'string') {
              return;
            }

            const source = node.source.value;
            const unsafeRootMessage = CLIENT_UNSAFE_ROOT_IMPORTS[source];

            if (unsafeRootMessage) {
              context.report({
                node: node.source,
                messageId: 'unsafeRoot',
                data: { message: unsafeRootMessage },
              });

              return;
            }

            if (CLIENT_SERVER_ENTRYPOINT_RE.test(source)) {
              context.report({ node: node.source, messageId: 'unsafeServer' });
            }
          },
        };
      },
    },
  },
};

export const clientUnsafeRootImports = CLIENT_UNSAFE_ROOT_IMPORTS;

/** @type {import("eslint").Linter.Config[]} */
export const clientConfig = [
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    plugins: { 'roomote-client': clientImportBoundaryPlugin },
    rules: { 'roomote-client/no-unsafe-roomote-imports': 'error' },
  },
];
