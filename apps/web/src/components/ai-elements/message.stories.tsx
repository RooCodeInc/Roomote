'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import {
  ACP_TOOL_KINDS,
  FAST_AGENT_NATIVE_TOOL_CATALOG,
  type KnownAcpToolKind,
} from '@roomote/types';
import {
  CopyIcon,
  RefreshCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from '@/components/system';

import {
  Message,
  MessageAction,
  MessageActions,
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
  MessageContent,
  MessageCopyButton,
  MessageNewTaskButton,
  MessageResponse,
  MessageTimestamp,
  MessageToolbar,
} from './message';
import { CollapsibleContent } from './collapsible-content';
import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning';
import { AcpCommandOutputMessage } from '@/app/(sandbox)/task/[taskId]/messages/acp/AcpCommandOutputMessage';
import { AcpMessageItem } from '@/app/(sandbox)/task/[taskId]/messages/acp/AcpMessageItem';
import { AcpTodoSectionMessage } from '@/app/(sandbox)/task/[taskId]/messages/acp/AcpTodoSectionMessage';
import type {
  AcpTodoSectionUiMessage,
  AcpToolResultUiMessage,
} from '@/app/(sandbox)/task/[taskId]/messages/acp/types';

import { Suggestion, Suggestions } from './suggestion';
import {
  TodoList,
  TodoListItem,
  TodoListItemContent,
  TodoListItemIndicator,
  TodoListItems,
  TodoListSection,
  TodoListSectionContent,
  TodoListSectionLabel,
  TodoListSectionTrigger,
} from './todo-list';

const meta: Meta = {
  title: 'Patterns/AI Elements/Conversation/Message',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

type StoryToolDefinition = {
  name: string;
  kind: KnownAcpToolKind;
  command?: string;
  isMcp?: boolean;
  provider?: string;
  rawInput?: Record<string, unknown>;
};

const EXTERNAL_MCP_TOOL_CALL = {
  name: 'search_issues',
  kind: ACP_TOOL_KINDS.mcp,
  isMcp: true,
  provider: 'linear',
  rawInput: { query: 'conversation rendering' },
} as const satisfies StoryToolDefinition;

const SESSION_TOOL_CALL_CATALOG = [
  ...FAST_AGENT_NATIVE_TOOL_CATALOG,
  EXTERNAL_MCP_TOOL_CALL,
] as const satisfies readonly StoryToolDefinition[];

const TASK_TOOL_CALL_CATALOG = {
  [ACP_TOOL_KINDS.execute]: {
    name: 'execute_command',
    kind: ACP_TOOL_KINDS.execute,
    command: 'pnpm check-types',
  },
  [ACP_TOOL_KINDS.read]: {
    name: 'read_file',
    kind: ACP_TOOL_KINDS.read,
    rawInput: { path: 'apps/web/src/components/ai-elements/message.tsx' },
  },
  [ACP_TOOL_KINDS.search]: {
    name: 'search_files',
    kind: ACP_TOOL_KINDS.search,
    rawInput: { query: 'ToolHeader' },
  },
  [ACP_TOOL_KINDS.list]: {
    name: 'list_files',
    kind: ACP_TOOL_KINDS.list,
    rawInput: { path: 'apps/web/src/components/ai-elements' },
  },
  [ACP_TOOL_KINDS.edit]: {
    name: 'edit_file',
    kind: ACP_TOOL_KINDS.edit,
    rawInput: {
      path: 'apps/web/src/components/ai-elements/message.stories.tsx',
    },
  },
  [ACP_TOOL_KINDS.subagent]: {
    name: 'task',
    kind: ACP_TOOL_KINDS.subagent,
    rawInput: { prompt: 'Inspect the conversation renderer.' },
  },
  [ACP_TOOL_KINDS.task]: {
    name: 'manage_tasks',
    kind: ACP_TOOL_KINDS.task,
    isMcp: true,
    provider: 'roomote',
    rawInput: { action: 'get_summary', taskId: 'task-storybook' },
  },
  [ACP_TOOL_KINDS.communication]: {
    name: 'send_chat_reply',
    kind: ACP_TOOL_KINDS.communication,
    isMcp: true,
    provider: 'roomote',
    rawInput: { message: 'The implementation is complete.' },
  },
  [ACP_TOOL_KINDS.memory]: {
    name: 'save_task_memory',
    kind: ACP_TOOL_KINDS.memory,
    isMcp: true,
    provider: 'roomote',
    rawInput: { outcome: 'Documented the transcript rendering behavior.' },
  },
  [ACP_TOOL_KINDS.artifact]: {
    name: 'manage_artifacts',
    kind: ACP_TOOL_KINDS.artifact,
    isMcp: true,
    provider: 'roomote',
    rawInput: { action: 'list' },
  },
  [ACP_TOOL_KINDS.widget]: {
    name: 'show_widget',
    kind: ACP_TOOL_KINDS.widget,
    isMcp: true,
    provider: 'roomote',
    rawInput: { html: '<p>Tool preview</p>', title: 'Tool preview' },
  },
  [ACP_TOOL_KINDS.mcp]: EXTERNAL_MCP_TOOL_CALL,
  [ACP_TOOL_KINDS.tool]: {
    name: 'request_environment_variables',
    kind: ACP_TOOL_KINDS.tool,
    isMcp: true,
    provider: 'roomote',
    rawInput: { variables: ['STORYBOOK_TOKEN'] },
  },
} as const satisfies Record<KnownAcpToolKind, StoryToolDefinition>;

function toolResultMessage(
  tool: StoryToolDefinition,
  surface: 'session' | 'task',
  index: number,
): AcpToolResultUiMessage {
  const isExecute = tool.kind === ACP_TOOL_KINDS.execute;
  const isMcp = tool.isMcp ?? false;

  return {
    id: `${surface}-tool-${index}`,
    ts: index + 1,
    role: 'tool',
    partial: false,
    sessionId: `${surface}-storybook`,
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: '{}',
    data: {
      toolCallId: `${surface}-tool-call-${index}`,
      kind: tool.kind,
      title: tool.name,
      status: 'completed',
      isExecute,
      isRead: tool.kind === ACP_TOOL_KINDS.read,
      isMcp,
      mcpServerName: isMcp ? (tool.provider ?? 'roomote') : null,
      mcpToolName: isMcp ? tool.name : null,
      serverName: isMcp ? (tool.provider ?? 'roomote') : null,
      toolName: tool.name,
      command: tool.command ?? null,
      exitCode: isExecute ? 0 : null,
      output: '{}',
      ...(tool.kind === ACP_TOOL_KINDS.subagent
        ? { isSubagentSpawn: true, prompt: tool.rawInput?.prompt }
        : {}),
      ...(tool.rawInput ? { rawInput: tool.rawInput } : {}),
    } as AcpToolResultUiMessage['data'],
  };
}

function ToolCallInventory({
  tools,
  surface,
}: {
  tools: readonly StoryToolDefinition[];
  surface: 'session' | 'task';
}) {
  return (
    <div className="flex flex-col gap-2">
      {tools.map((tool, index) => (
        <AcpMessageItem
          key={`${surface}:${tool.name}`}
          msg={toolResultMessage(tool, surface, index)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full Conversations
// ---------------------------------------------------------------------------

export const FullConversationKitchenSink: Story = {
  name: 'Full Conversation (Kitchen Sink)',
  render: () => {
    const t0 = new Date('2025-08-04T14:00:00Z').getTime();
    const t1 = new Date('2025-08-04T14:00:03Z').getTime();
    const tTodo = new Date('2025-08-04T14:00:45Z').getTime();
    const t2 = new Date('2025-08-04T14:01:15Z').getTime();
    const t3 = new Date('2025-08-04T14:01:18Z').getTime();

    return (
      <div className="flex flex-col gap-4">
        {/* User message */}
        <Message from="user">
          <MessageContent>
            Refactor the auth module to use JWT tokens instead of session
            cookies. Make sure to add refresh token rotation.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t0} />
          </MessageActions>
        </Message>

        {/* Assistant reasons, updates the plan, and responds. */}
        <Message from="assistant">
          <Reasoning defaultOpen={false} duration={4200}>
            <ReasoningTrigger />
            <ReasoningContent>
              {`The user wants a full JWT refactor. I need to:
1. Read the existing auth module
2. Create JWT utility functions
3. Update the middleware
4. Add refresh token rotation
5. Run the tests to make sure nothing breaks`}
            </ReasoningContent>
          </Reasoning>
          <MessageContent>
            <MessageResponse>
              {`I've created the JWT service and updated the middleware. Here's a summary:

**Files modified:**
- \`src/lib/jwt.ts\` — New file with \`generateToken\` and \`verifyToken\`
- \`src/middleware.ts\` — Swapped session lookup for JWT verification

\`\`\`typescript
export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: '15m',
    algorithm: 'ES256',
  });
}
\`\`\`

I'm now working on refresh token rotation. Would you like me to continue?`}
            </MessageResponse>
            <Suggestions>
              <Suggestion suggestion="Yes, continue with refresh tokens" />
              <Suggestion suggestion="Run the tests first" />
              <Suggestion suggestion="Show me the full diff" />
            </Suggestions>
          </MessageContent>
          <MessageActions>
            <MessageCopyButton content="I've created the JWT service..." />
            <MessageNewTaskButton content="Add refresh token rotation to the JWT auth module" />
            <MessageTimestamp ts={t1} previousTs={t0} />
          </MessageActions>
        </Message>

        <AcpTodoSectionMessage
          msg={todoSectionMsg('Refresh token rotation', {
            id: 'todo-heading-1',
            ts: tTodo,
          })}
        />

        {/* User picks a suggestion */}
        <Message from="user">
          <MessageContent>Run the tests first</MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t2} previousTs={t1} />
          </MessageActions>
        </Message>

        {/* Assistant reasons about the validation result. */}
        <Message from="assistant">
          <Reasoning isStreaming={false} defaultOpen={false} duration={2100}>
            <ReasoningTrigger />
            <ReasoningContent>
              {`The user wants me to run the tests first. Let me execute the test suite and also check the database to make sure the session migration won't affect existing users.

I should:
1. Run the auth tests with pnpm
2. Query the users table via MCP to check active session counts
3. Report back with results`}
            </ReasoningContent>
          </Reasoning>
          <MessageContent>
            <MessageResponse>
              {`All 6 tests pass. I also checked the database — there are **142 active sessions** that will need to be migrated. The latest CI run on GitHub is green.

Ready to add refresh token rotation whenever you are.`}
            </MessageResponse>
          </MessageContent>
          <MessageActions>
            <MessageCopyButton content="All 6 tests pass..." />
            <MessageTimestamp ts={t3} previousTs={t2} />
          </MessageActions>
        </Message>
      </div>
    );
  },
};

export const FullConversationNarrationMode: Story = {
  name: 'Full Conversation (Narration Mode)',
  render: () => {
    const t0 = new Date('2025-08-04T15:10:00Z').getTime();
    const t1 = new Date('2025-08-04T15:10:06Z').getTime();
    const tTodo1 = new Date('2025-08-04T15:10:20Z').getTime();
    const t2 = new Date('2025-08-04T15:10:40Z').getTime();
    const t3 = new Date('2025-08-04T15:10:58Z').getTime();
    const t4 = new Date('2025-08-04T15:11:15Z').getTime();
    const t5 = new Date('2025-08-04T15:11:32Z').getTime();
    const tTodo2 = new Date('2025-08-04T15:11:50Z').getTime();
    const t6 = new Date('2025-08-04T15:12:10Z').getTime();
    const t7 = new Date('2025-08-04T15:12:28Z').getTime();
    const t8 = new Date('2025-08-04T15:12:46Z').getTime();
    const t9 = new Date('2025-08-04T15:13:05Z').getTime();

    return (
      <div className="flex flex-col gap-4">
        <Message from="user">
          <MessageContent>
            I need to migrate our auth flow from session cookies to JWT with
            refresh token rotation. Please narrate exactly what you&apos;re
            doing as you go.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t0} />
          </MessageActions>
        </Message>

        <Message from="assistant">
          <MessageContent>
            I&apos;ll run this as a narrated migration. First I&apos;m mapping
            every place where sessions are read or mutated so we can avoid
            missing edge paths during cutover.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t1} previousTs={t0} />
          </MessageActions>
        </Message>

        <AcpTodoSectionMessage
          msg={todoSectionMsg('Map session-dependent auth paths', {
            id: 'todo-heading-narration-1',
            ts: tTodo1,
          })}
        />

        <Message from="assistant">
          <MessageContent>
            I found dependencies in middleware guards, a couple API handlers,
            and the sign-out sequence. I&apos;m documenting each touchpoint so
            we can implement JWT checks in parallel without interrupting active
            users.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t2} previousTs={t1} />
          </MessageActions>
        </Message>

        <Message from="user">
          <MessageContent>
            Keep backward compatibility during rollout. We can&apos;t force
            everyone to re-authenticate at once.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t3} previousTs={t2} />
          </MessageActions>
        </Message>

        <Message from="assistant">
          <MessageContent>
            Agreed. I&apos;m planning a dual-read period: middleware will accept
            JWT first, then fall back to session validation. That lets us
            migrate incrementally and compare auth success rates side by side.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t4} previousTs={t3} />
          </MessageActions>
        </Message>

        <Message from="user">
          <MessageContent>
            Please include rollback criteria and tell me what metrics to watch.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t5} previousTs={t4} />
          </MessageActions>
        </Message>

        <AcpTodoSectionMessage
          msg={todoSectionMsg('Add refresh token rotation + reuse detection', {
            id: 'todo-heading-narration-2',
            ts: tTodo2,
          })}
        />

        <Message from="assistant">
          <MessageContent>
            I&apos;m implementing one-time refresh token rotation now. On each
            refresh, the previous token is revoked immediately and a new token
            family record is issued so suspected replay attempts can invalidate
            the entire chain.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t6} previousTs={t5} />
          </MessageActions>
        </Message>

        <Message from="assistant">
          <MessageContent>
            Rollback plan: if JWT validation errors rise above baseline or token
            refresh failures exceed threshold, we keep sessions as primary auth,
            disable token issuance for new logins, and invalidate only newly
            minted refresh families.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t7} previousTs={t6} />
          </MessageActions>
        </Message>

        <Message from="user">
          <MessageContent>
            Perfect. Please summarize the rollout order for engineering and
            support teams.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t8} previousTs={t7} />
          </MessageActions>
        </Message>

        <Message from="assistant">
          <MessageContent>
            Rollout order is: enable dual-read in staging, enable JWT issuance
            for 10% of monitor auth and refresh metrics, expand to 100% once
            stable, then retire legacy session checks with a scheduled cleanup
            window and support playbook.
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={t9} previousTs={t8} />
          </MessageActions>
        </Message>
      </div>
    );
  },
};

// ---------------------------------------------------------------------------
// Basic Messages
// ---------------------------------------------------------------------------

export const UserMessage: Story = {
  render: () => (
    <Message from="user">
      <MessageContent>
        Can you help me refactor the authentication module to use JWT tokens
        instead of session cookies?
      </MessageContent>
    </Message>
  ),
};

export const UserMessageWithMarkdown: Story = {
  name: 'User Message (Markdown)',
  render: () => (
    <Message from="user">
      <MessageContent>
        <MessageResponse>
          {`I need to implement a new feature in our application. The feature should:

1. Allow users to create **custom dashboards**
2. Support drag-and-drop widget placement
3. Include a library of pre-built widgets (charts, tables, metrics)
4. Persist dashboard layouts per user
5. Support real-time data updates via \`WebSocket\`

The tech stack is Next.js 16 with React 19, Tailwind CSS, and PostgreSQL.
Please start by analyzing the existing codebase and creating an implementation plan.`}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

export const UserMessageCollapsed: Story = {
  name: 'User Message (collapsed)',
  render: () => (
    <Message from="user">
      <MessageContent>
        <CollapsibleContent>
          <MessageResponse>
            {`Here is a very long specification document that I need you to implement. Please review it carefully.

## Authentication Module

The authentication system needs to support the following:

1. **JWT-based authentication** with access and refresh tokens
2. **OAuth2 integration** for Google, GitHub, and Microsoft
3. **Multi-factor authentication** (TOTP and WebAuthn)
4. **Session management** with configurable timeouts
5. **Role-based access control** with hierarchical permissions

### Token Configuration

\`\`\`typescript
interface TokenConfig {
  accessTokenTTL: number;     // 15 minutes default
  refreshTokenTTL: number;    // 7 days default
  issuer: string;
  audience: string[];
  algorithm: 'RS256' | 'ES256';
}
\`\`\`

### Database Schema

The following tables are required:

- \`users\` - Core user table with profile data
- \`sessions\` - Active session tracking
- \`refresh_tokens\` - Refresh token storage with rotation support
- \`oauth_accounts\` - Linked OAuth provider accounts
- \`mfa_devices\` - Registered MFA devices per user
- \`permissions\` - Permission definitions
- \`roles\` - Role definitions with permission mappings
- \`user_roles\` - User-to-role assignments

### API Endpoints

#### Authentication Flow
- \`POST /auth/register\` - New user registration
- \`POST /auth/login\` - Email/password login
- \`POST /auth/logout\` - Invalidate current session
- \`POST /auth/refresh\` - Refresh access token
- \`POST /auth/forgot-password\` - Initiate password reset
- \`POST /auth/reset-password\` - Complete password reset

### Security Requirements

- All passwords must be hashed with **argon2id**
- Rate limiting on authentication endpoints: 10 req/min per IP
- CSRF protection on all state-changing endpoints
- Refresh token rotation with reuse detection

Please implement this according to the project's existing patterns.`}
          </MessageResponse>
        </CollapsibleContent>
      </MessageContent>
    </Message>
  ),
};

export const AssistantMessage: Story = {
  name: 'Assistant Message (plain text)',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        I&apos;ll help you refactor the authentication module. Let me start by
        reading the existing implementation to understand the current setup.
      </MessageContent>
    </Message>
  ),
};

// ---------------------------------------------------------------------------
// MessageResponse (Markdown)
// ---------------------------------------------------------------------------

export const AssistantWithMarkdown: Story = {
  name: 'Assistant – Rich Markdown (Kitchen Sink)',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {`# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

---

## Inline Formatting

This is **bold text** and this is *italic text*. You can combine ***bold and italic***. Here's ~~strikethrough~~ text. Inline \`code\` looks like this. Here's a [link to OpenAI](https://openai.com) and an auto-linked URL: https://example.com.

## Blockquotes

> This is a single-level blockquote.

> **Nested blockquotes:**
>
> First level of quoting.
>
> > Second level — a quote within a quote.
> >
> > > Third level — going even deeper.
>
> Back to the first level.

## Unordered Lists

- Item one
- Item two
  - Nested item 2a
  - Nested item 2b
    - Deeply nested item
- Item three

Alternate bullet style:

* Asterisk item
* Another asterisk item

## Ordered Lists

1. First item
2. Second item
   1. Sub-item 2.1
   2. Sub-item 2.2
3. Third item

## Mixed Nested Lists

1. Set up the project
   - Install dependencies
   - Configure environment
2. Implement features
   - Authentication
     1. JWT tokens
     2. Refresh rotation
     3. Middleware
   - Database layer
3. Ship it 🚀

## Task Lists

- [x] Design the schema
- [x] Implement the API
- [ ] Write unit tests
- [ ] Deploy to production

## Tables

| Feature | Status | Priority | Owner |
|---------|--------|----------|-------|
| Auth | ✅ Done | High | Alice |
| Dashboard | 🚧 WIP | High | Bob |
| Notifications | ❌ Blocked | Medium | Carol |
| Dark Mode | ✅ Done | Low | Dave |

Right-aligned and centered columns:

| Left | Center | Right |
|:-----|:------:|------:|
| L1 | C1 | R1 |
| L2 | C2 | R2 |
| L3 | C3 | R3 |

## Code Blocks

Inline code: Use \`const x = 42;\` for constants.

TypeScript:

\`\`\`typescript
import jwt from 'jsonwebtoken';

interface TokenPayload {
  sub: string;
  role: 'admin' | 'user' | 'guest';
  permissions: string[];
}

export async function generateToken(payload: TokenPayload): Promise<string> {
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: '15m',
    algorithm: 'HS256',
  });
}
\`\`\`

Python:

\`\`\`python
def fibonacci(n: int) -> list[int]:
    """Generate the first n Fibonacci numbers."""
    if n <= 0:
        return []
    sequence = [0, 1]
    while len(sequence) < n:
        sequence.append(sequence[-1] + sequence[-2])
    return sequence[:n]

print(fibonacci(10))  # [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
\`\`\`

Bash / Shell:

\`\`\`bash
#!/bin/bash
set -euo pipefail

echo "Deploying to production..."
docker build -t myapp:latest .
docker push myapp:latest
kubectl rollout restart deployment/myapp
echo "✅ Deployment complete"
\`\`\`

JSON:

\`\`\`json
{
  "name": "my-project",
  "version": "2.0.0",
  "dependencies": {
    "react": "^19.0.0",
    "next": "^16.0.0"
  },
  "scripts": {
    "dev": "next dev",
    "build": "next build"
  }
}
\`\`\`

SQL:

\`\`\`sql
SELECT u.name, COUNT(o.id) AS order_count, SUM(o.total) AS total_spent
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= '2025-01-01'
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 5
ORDER BY total_spent DESC
LIMIT 10;
\`\`\`

CSS:

\`\`\`css
.container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.5rem;
  padding: 2rem;
}

@media (prefers-color-scheme: dark) {
  .container {
    background: #1a1a2e;
    color: #eee;
  }
}
\`\`\`

Plain text (no syntax highlighting):

\`\`\`
This is a plain code block with no language specified.
It preserves whitespace and uses monospace font.
    Indented line.
\`\`\`

## Horizontal Rules

Content above.

---

Content between.

***

Content below.

## Images

![Alt text for an image](https://placehold.co/600x200/1a1a2e/white?text=Placeholder+Image)

## Links

- [Basic link](https://example.com)
- [Link with title](https://example.com "Example Site")
- Auto-linked: https://github.com
- Email: contact@example.com

## Emphasis Combinations

- **Bold**
- *Italic*
- ***Bold and italic***
- ~~Strikethrough~~
- ~~**Bold strikethrough**~~
- **\`bold code\`**
- *\`italic code\`*

## Long Paragraph

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

## Line Breaks

First line with two trailing spaces
Second line right after.

Third line after a blank line.

## Escaping Special Characters

\\*This is not italic\\* and \\*\\*this is not bold\\*\\*.

Use backticks to show literal \\\`code\\\` markers.

## Footnote-style References

This feature requires JWT tokens[^1] with proper rotation[^2].

[^1]: JSON Web Tokens — an open standard (RFC 7519).
[^2]: Refresh token rotation prevents replay attacks.

## Definition Lists

Term 1
: Definition for term 1.

Term 2
: Definition for term 2, which can span
  multiple lines.

## Math (if supported)

Inline math: $E = mc^2$

Block math:

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

## Summary / Details

<details>
<summary>Click to expand</summary>

This content is hidden by default but can be expanded. It supports **full markdown** inside:

- Item A
- Item B

\`\`\`js
console.log("Inside a details block!");
\`\`\`

</details>

## Emoji

Roomote loves shipping features 🚀✨🎉👏🔥

That covers just about every Markdown construct! 🎯`}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

export const AssistantWithCode: Story = {
  name: 'Assistant – With Code Blocks',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {`I've created the JWT service. Here's the implementation:

\`\`\`typescript
import jwt from 'jsonwebtoken';

interface TokenPayload {
  sub: string;
  role: 'admin' | 'user' | 'guest';
}

export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: '15m',
  });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
}
\`\`\`

You can use the \`generateToken\` function in your login endpoint and \`verifyToken\` in the auth middleware.

For the refresh token, I recommend using a separate longer-lived token:

\`\`\`typescript
export function generateRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.REFRESH_SECRET!, {
    expiresIn: '7d',
  });
}
\`\`\``}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

export const AssistantWithInlineCode: Story = {
  name: 'Assistant – Inline Code',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {`The error is in your \`useAuth\` hook. You're calling \`setUser(data)\` instead of \`setUser(data.user)\`. The \`data\` object returned from the API has a \`user\` property nested inside it.

Also, make sure to add \`await\` before the \`fetch()\` call — without it, you're passing a Promise to \`.json()\` instead of the Response.`}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

export const AssistantWithList: Story = {
  name: 'Assistant – Lists and Links',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {`Here are the files I've modified:

- **src/hooks/useAuth.ts** — Added JWT token handling
- **src/middleware.ts** — Updated to verify JWT tokens
- **src/lib/jwt.ts** — New file with token utilities

External references:
- [JWT Best Practices](https://auth0.com/blog/jwt-security-best-practices/)
- [OWASP Token Storage](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)

All changes are backward-compatible. No existing tests should break.`}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

// ---------------------------------------------------------------------------
// Message Actions
// ---------------------------------------------------------------------------

export const WithActions: Story = {
  name: 'Message with Actions',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          I&apos;ve completed the implementation of the dark mode toggle.
        </MessageResponse>
      </MessageContent>
      <MessageActions>
        <MessageAction tooltip="Copy">
          <CopyIcon className="size-4" />
        </MessageAction>
        <MessageAction tooltip="Regenerate">
          <RefreshCwIcon className="size-4" />
        </MessageAction>
        <MessageAction tooltip="Good response">
          <ThumbsUpIcon className="size-4" />
        </MessageAction>
        <MessageAction tooltip="Bad response">
          <ThumbsDownIcon className="size-4" />
        </MessageAction>
      </MessageActions>
    </Message>
  ),
};

export const ActionWithoutTooltip: Story = {
  name: 'Action without Tooltip',
  render: () => (
    <MessageActions>
      <MessageAction label="Copy message">
        <CopyIcon className="size-4" />
      </MessageAction>
    </MessageActions>
  ),
};

export const CopyButton: Story = {
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          This message has a copy button in the action bar.
        </MessageResponse>
      </MessageContent>
      <MessageActions>
        <MessageCopyButton content="This message has a copy button in the action bar." />
      </MessageActions>
    </Message>
  ),
};

export const NewTaskButton: Story = {
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          This message has a &quot;Use for new task&quot; button that navigates
          to the home page with the message content as a prompt parameter.
        </MessageResponse>
      </MessageContent>
      <MessageActions>
        <MessageNewTaskButton content="Refactor the auth module to use JWT tokens" />
      </MessageActions>
    </Message>
  ),
};

export const FullActionBar: Story = {
  name: 'Full Action Bar (Copy + New Task + Timestamp)',
  render: () => {
    const prevTs = new Date('2025-08-04T12:36:10Z').getTime();
    const ts = new Date('2025-08-04T12:40:00Z').getTime();

    return (
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            This demonstrates the full action bar as it appears in the real
            TextMessage component: copy, new task, and timestamp. Hover the
            message to reveal the actions.
          </MessageResponse>
        </MessageContent>
        <MessageActions>
          <MessageCopyButton content="This demonstrates the full action bar..." />
          <MessageNewTaskButton content="This demonstrates the full action bar..." />
          <MessageTimestamp ts={ts} previousTs={prevTs} />
        </MessageActions>
      </Message>
    );
  },
};

// ---------------------------------------------------------------------------
// Message Toolbar
// ---------------------------------------------------------------------------

export const WithToolbar: Story = {
  name: 'Message with Toolbar',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          Here&apos;s my analysis of the codebase structure.
        </MessageResponse>
      </MessageContent>
      <MessageToolbar>
        <MessageActions>
          <MessageAction tooltip="Copy">
            <CopyIcon className="size-4" />
          </MessageAction>
          <MessageAction tooltip="Regenerate">
            <RefreshCwIcon className="size-4" />
          </MessageAction>
        </MessageActions>
        <MessageActions>
          <MessageAction tooltip="Good response">
            <ThumbsUpIcon className="size-4" />
          </MessageAction>
          <MessageAction tooltip="Bad response">
            <ThumbsDownIcon className="size-4" />
          </MessageAction>
        </MessageActions>
      </MessageToolbar>
    </Message>
  ),
};

// ---------------------------------------------------------------------------
// Message Branching
// ---------------------------------------------------------------------------

export const Branching: Story = {
  name: 'Message Branching (3 branches)',
  render: () => (
    <Message from="assistant">
      <MessageBranch>
        <MessageBranchContent>
          <MessageContent key="branch-0">
            <MessageResponse>
              **Branch 1:** I recommend using Redis for session storage. It
              offers sub-millisecond latency and built-in TTL support.
            </MessageResponse>
          </MessageContent>
          <MessageContent key="branch-1">
            <MessageResponse>
              **Branch 2:** PostgreSQL is a solid choice for session storage if
              you want persistence and don&apos;t need extreme performance.
            </MessageResponse>
          </MessageContent>
          <MessageContent key="branch-2">
            <MessageResponse>
              **Branch 3:** Consider using JWT tokens with refresh rotation.
              This eliminates the need for server-side session storage entirely.
            </MessageResponse>
          </MessageContent>
        </MessageBranchContent>
        <MessageToolbar>
          <MessageBranchSelector from="assistant">
            <MessageBranchPrevious />
            <MessageBranchPage />
            <MessageBranchNext />
          </MessageBranchSelector>
        </MessageToolbar>
      </MessageBranch>
    </Message>
  ),
};

// ---------------------------------------------------------------------------
// Conversation Flow
// ---------------------------------------------------------------------------

export const ConversationExchange: Story = {
  name: 'User/Assistant Exchange',
  render: () => {
    const userTs = new Date('2025-08-04T12:38:00Z').getTime();
    const assistantTs = new Date('2025-08-04T12:38:02Z').getTime();

    return (
      <div className="flex flex-col gap-4">
        <Message from="user">
          <MessageContent>How do I center a div?</MessageContent>
          <MessageActions>
            <MessageTimestamp ts={userTs} />
          </MessageActions>
        </Message>
        <Message from="assistant">
          <MessageContent>
            <MessageResponse>
              {`There are several ways to center a div. Here are the most common approaches:

**Flexbox (recommended):**
\`\`\`css
.parent {
  display: flex;
  justify-content: center;
  align-items: center;
}
\`\`\`

**Grid:**
\`\`\`css
.parent {
  display: grid;
  place-items: center;
}
\`\`\`

The flexbox approach is the most widely used and supported.`}
            </MessageResponse>
          </MessageContent>
          <MessageActions>
            <MessageTimestamp ts={assistantTs} previousTs={userTs} />
          </MessageActions>
        </Message>
      </div>
    );
  },
};

// ---------------------------------------------------------------------------
// Timestamp Demo
// ---------------------------------------------------------------------------

export const WithTimestamp: Story = {
  name: 'With Hover Timestamp',
  render: () => {
    const prevTs = new Date('2025-08-04T12:36:10Z').getTime();
    const ts = new Date('2025-08-04T12:40:00Z').getTime();

    return (
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            Hover over this message to see the timestamp appear in the actions
            bar. Then hover the timestamp itself for 3 seconds to see how long
            it has been since the previous message.
          </MessageResponse>
        </MessageContent>
        <MessageActions>
          <MessageTimestamp ts={ts} previousTs={prevTs} />
        </MessageActions>
      </Message>
    );
  },
};

export const WithTimestampNoPrevious: Story = {
  name: 'With Hover Timestamp (first message)',
  render: () => {
    const ts = new Date('2025-08-04T12:40:00Z').getTime();

    return (
      <Message from="user">
        <MessageContent>
          This is the first message in the conversation so hovering the
          timestamp won&apos;t show a duration tooltip.
        </MessageContent>
        <MessageActions>
          <MessageTimestamp ts={ts} />
        </MessageActions>
      </Message>
    );
  },
};

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

export const WithReasoning: Story = {
  name: 'Assistant – With Reasoning',
  render: () => (
    <Message from="assistant">
      <Reasoning defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>
          {`The user wants to refactor auth to JWT. Let me think through the steps:

1. Replace session cookie creation with JWT token generation
2. Update middleware to validate JWT instead of session lookup
3. Add refresh token rotation for security
4. Update the client to store tokens in memory (not localStorage)`}
        </ReasoningContent>
      </Reasoning>
      <MessageContent>
        <MessageResponse>
          {`I've analyzed the current authentication setup. Here's my plan:

1. **Replace sessions with JWT** — generate short-lived access tokens (15 min)
2. **Add refresh token rotation** — 7-day refresh tokens stored in httpOnly cookies
3. **Update middleware** — swap session lookup for JWT verification

Let me start with the token generation service.`}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

// ---------------------------------------------------------------------------
// Product Tool Calls
// ---------------------------------------------------------------------------

export const FastSessionToolCalls: Story = {
  name: 'Fast Session – All Tool Calls',
  render: () => (
    <ToolCallInventory tools={SESSION_TOOL_CALL_CATALOG} surface="session" />
  ),
};

export const TaskToolCalls: Story = {
  name: 'Task – All Tool Call Kinds',
  render: () => (
    <ToolCallInventory
      tools={Object.values(TASK_TOOL_CALL_CATALOG)}
      surface="task"
    />
  ),
};

// ---------------------------------------------------------------------------
// Streaming Reasoning (Thinking)
// ---------------------------------------------------------------------------

export const WithStreamingReasoning: Story = {
  name: 'Assistant – Streaming Reasoning (Thinking)',
  render: () => (
    <Message from="assistant">
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>
          {`Let me analyze the user's request. They want to integrate with three external services via MCP:

1. **PostgreSQL** — query user data and session history
2. **GitHub** — fetch repository metadata and recent commits
3. **Linear** — search for related issues and link them

I should start by querying the database to get the user record, then use the GitHub API to find their repos, and finally cross-reference with Linear issues...`}
        </ReasoningContent>
      </Reasoning>
      <MessageContent>
        <MessageResponse>
          {`I'm analyzing the integration requirements across all three services...`}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

// ---------------------------------------------------------------------------
// Command Output (AcpCommandOutputMessage)
// ---------------------------------------------------------------------------

function cmdMsg(
  overrides: { command?: string; text?: string; exitCode?: number } = {},
): AcpToolResultUiMessage {
  return {
    id: 'story-msg',
    ts: 0,
    role: 'assistant',
    partial: false,
    sessionId: null,
    updateType: 'tool_result',
    kind: 'tool_result',
    text: overrides.text ?? '',
    data: {
      toolCallId: null,
      kind: 'execute',
      title: null,
      isExecute: true,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: overrides.command ?? null,
      exitCode: overrides.exitCode ?? null,
      output: overrides.text ?? '',
      status: null,
    },
  } as unknown as AcpToolResultUiMessage;
}

function todoSectionMsg(
  content: string,
  overrides: Partial<AcpTodoSectionUiMessage> = {},
): AcpTodoSectionUiMessage {
  return {
    id: overrides.id ?? 'todo-section-story',
    ts: overrides.ts ?? 0,
    role: overrides.role ?? 'assistant',
    partial: overrides.partial ?? false,
    sessionId: overrides.sessionId ?? null,
    updateType: overrides.updateType ?? 'roomote_runtime.plan',
    kind: 'todo_section',
    text: content,
    data: {
      todoId: 'todo-story',
      content,
    },
  };
}

export const WithCommandOutput: Story = {
  name: 'Assistant – With Command Output',
  render: () => (
    <div className="flex flex-col gap-4">
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            {`I ran the test suite after the refactor. Here are the results:`}
          </MessageResponse>
        </MessageContent>
      </Message>

      {/* Failed test run */}
      <AcpCommandOutputMessage
        msg={cmdMsg({
          command: 'pnpm test src/lib/auth',
          text: `✓ should generate a valid JWT token (3ms)
✓ should verify a valid token (1ms)
✓ should reject an expired token (2ms)
✓ should rotate refresh tokens (5ms)
✗ should reject tampered tokens (expected SignatureError)

Tests:  4 passed, 1 failed, 5 total
Time:   0.42s`,
          exitCode: 1,
        })}
        ts={1700000001000}
        status="failed"
      />

      {/* Running command (spinner) */}
      <AcpCommandOutputMessage
        msg={cmdMsg({
          command: 'docker build -t myapp:latest .',
          text: '',
        })}
        ts={1700000002000}
        status="in_progress"
      />

      {/* Successful command */}
      <AcpCommandOutputMessage
        msg={cmdMsg({
          command: 'pnpm install',
          text: `added 142 packages, and audited 143 packages in 3s

24 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities`,
          exitCode: 0,
        })}
        ts={1700000003000}
        status="completed"
      />

      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            {`One test is failing — I'll investigate the signature verification logic next.`}
          </MessageResponse>
        </MessageContent>
      </Message>
    </div>
  ),
};

// ---------------------------------------------------------------------------
// Todo List
// ---------------------------------------------------------------------------

export const WithTodoList: Story = {
  name: 'Assistant – With Todo List',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <TodoList>
          <TodoListSection>
            <TodoListSectionTrigger>
              <TodoListSectionLabel count={5} label="tasks remaining" />
            </TodoListSectionTrigger>
            <TodoListSectionContent>
              <TodoListItems>
                <TodoListItem completed>
                  <span className="flex items-center gap-2">
                    <TodoListItemIndicator completed />
                    <TodoListItemContent>
                      Analyze existing auth module
                    </TodoListItemContent>
                  </span>
                </TodoListItem>
                <TodoListItem completed>
                  <span className="flex items-center gap-2">
                    <TodoListItemIndicator completed />
                    <TodoListItemContent>
                      Create JWT token service
                    </TodoListItemContent>
                  </span>
                </TodoListItem>
                <TodoListItem inProgress>
                  <span className="flex items-center gap-2">
                    <TodoListItemIndicator inProgress />
                    <TodoListItemContent>
                      Update auth middleware
                    </TodoListItemContent>
                  </span>
                </TodoListItem>
                <TodoListItem>
                  <span className="flex items-center gap-2">
                    <TodoListItemIndicator />
                    <TodoListItemContent>
                      Add refresh token rotation
                    </TodoListItemContent>
                  </span>
                </TodoListItem>
                <TodoListItem>
                  <span className="flex items-center gap-2">
                    <TodoListItemIndicator />
                    <TodoListItemContent>
                      Write integration tests
                    </TodoListItemContent>
                  </span>
                </TodoListItem>
              </TodoListItems>
            </TodoListSectionContent>
          </TodoListSection>
        </TodoList>
        <MessageResponse>
          {`I'm currently updating the auth middleware to validate JWT tokens instead of looking up sessions. Two tasks are done, one in progress, and two remaining.`}
        </MessageResponse>
      </MessageContent>
    </Message>
  ),
};

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export const WithSuggestions: Story = {
  name: 'Assistant – With Suggestions',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {`I've finished the JWT implementation. Would you like me to proceed with any of the following?`}
        </MessageResponse>
        <Suggestions>
          <Suggestion suggestion="Yes, add refresh token rotation" />
          <Suggestion suggestion="Write unit tests first" />
          <Suggestion suggestion="Show me the full diff before continuing" />
        </Suggestions>
      </MessageContent>
    </Message>
  ),
};

export const WithSuggestionsAnswered: Story = {
  name: 'Assistant – Suggestions (answered)',
  render: () => (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {`I've finished the JWT implementation. Would you like me to proceed with any of the following?`}
        </MessageResponse>
        <Suggestions>
          <Suggestion suggestion="Yes, add refresh token rotation" disabled />
          <Suggestion suggestion="Write unit tests first" disabled selected />
          <Suggestion
            suggestion="Show me the full diff before continuing"
            disabled
          />
        </Suggestions>
      </MessageContent>
    </Message>
  ),
};
