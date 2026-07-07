'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { DiffLine } from './code-block';

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCommand,
  CodeBlockCopyButton,
  CodeBlockDiff,
  CodeBlockDiffContent,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockLanguageSelector,
  CodeBlockLanguageSelectorContent,
  CodeBlockLanguageSelectorItem,
  CodeBlockLanguageSelectorTrigger,
  CodeBlockLanguageSelectorValue,
  CodeBlockTitle,
} from './code-block';

const meta: Meta = {
  title: 'Patterns/AI Elements/Conversation/CodeBlock',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Code samples
// ---------------------------------------------------------------------------

const TS_CODE = `import { useState, useCallback } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      setUser(data.user);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    setUser(null);
  }, []);

  return { user, isLoading, login, logout };
}`;

const JS_CODE = `const express = require('express');
const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/users', async (req, res) => {
  const { name, email } = req.body;
  const user = await createUser({ name, email });
  res.status(201).json(user);
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});`;

const JSON_CODE = `{
  "name": "@roomote/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "test": "vitest"
  },
  "dependencies": {
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}`;

const PYTHON_CODE = `from typing import Optional
from dataclasses import dataclass
from datetime import datetime

@dataclass
class Task:
    id: str
    title: str
    description: str
    status: str = "pending"
    created_at: datetime = datetime.now()

class TaskService:
    def __init__(self, db):
        self.db = db

    async def create_task(self, title: str, description: str) -> Task:
        task = Task(
            id=str(uuid4()),
            title=title,
            description=description,
        )
        await self.db.tasks.insert(task)
        return task

    async def get_task(self, task_id: str) -> Optional[Task]:
        return await self.db.tasks.find_one({"id": task_id})`;

const BASH_CODE = `#!/bin/bash
set -euo pipefail

echo "Starting deployment..."

# Build the project
pnpm build

# Run tests
pnpm test --coverage

# Deploy to staging
fly deploy --app my-app-staging

echo "Deployment complete!"`;

const CSS_CODE = `.container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

.card {
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1.5rem;
  background: var(--card);
  transition: box-shadow 0.2s ease;
}

.card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}`;

// ---------------------------------------------------------------------------
// Basic Stories
// ---------------------------------------------------------------------------

export const TypeScript: Story = {
  render: () => (
    <CodeBlock code={TS_CODE} language="typescript" showLineNumbers>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>useAuth.ts</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const JavaScript: Story = {
  render: () => (
    <CodeBlock code={JS_CODE} language="javascript" showLineNumbers>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>server.js</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const JSONData: Story = {
  name: 'JSON',
  render: () => (
    <CodeBlock code={JSON_CODE} language="json">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>package.json</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const Python: Story = {
  render: () => (
    <CodeBlock code={PYTHON_CODE} language="python" showLineNumbers>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>task_service.py</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const BashCommand: Story = {
  name: 'Bash with Command Header',
  render: () => (
    <CodeBlock code={BASH_CODE} language="bash" showLineNumbers>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockCommand>./deploy.sh</CodeBlockCommand>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const CSS: Story = {
  render: () => (
    <CodeBlock code={CSS_CODE} language="css" showLineNumbers>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>styles.css</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export const CollapsibleBlock: Story = {
  name: 'Collapsible (starts collapsed)',
  render: () => (
    <CodeBlock
      code={TS_CODE}
      language="typescript"
      collapsible
      showLineNumbers
      command="pnpm test -- --coverage"
      showCommandCopy
      showOutputCopy
    >
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockCommand>pnpm test -- --coverage</CodeBlockCommand>
        </CodeBlockTitle>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const ForceDark: Story = {
  name: 'Force Dark Theme',
  render: () => (
    <CodeBlock code={BASH_CODE} language="bash" forceDark>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockCommand>pnpm build</CodeBlockCommand>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const NoLineNumbers: Story = {
  render: () => (
    <CodeBlock code={JS_CODE} language="javascript">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>server.js</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

export const NoHeader: Story = {
  render: () => <CodeBlock code={JSON_CODE} language="json" />,
};

// ---------------------------------------------------------------------------
// Diff View
// ---------------------------------------------------------------------------

const DIFF_LINES: DiffLine[] = [
  { type: 'context', content: "import { useState } from 'react';" },
  { type: 'remove', content: "import { useEffect } from 'react';" },
  { type: 'add', content: "import { useCallback, useEffect } from 'react';" },
  { type: 'context', content: '' },
  { type: 'context', content: 'export function useAuth() {' },
  { type: 'context', content: '  const [user, setUser] = useState(null);' },
  {
    type: 'remove',
    content: '  const [loading, setLoading] = useState(false);',
  },
  {
    type: 'add',
    content: '  const [isLoading, setIsLoading] = useState(false);',
  },
  { type: 'context', content: '' },
  { type: 'remove', content: '  function login(email, password) {' },
  { type: 'remove', content: '    setLoading(true);' },
  { type: 'remove', content: '    fetch("/api/login", {' },
  {
    type: 'add',
    content: '  const login = useCallback(async (email, password) => {',
  },
  { type: 'add', content: '    setIsLoading(true);' },
  { type: 'add', content: '    try {' },
  {
    type: 'add',
    content: '      const res = await fetch("/api/auth/login", {',
  },
  { type: 'context', content: '        method: "POST",' },
  {
    type: 'context',
    content: '        headers: { "Content-Type": "application/json" },',
  },
  {
    type: 'context',
    content: '        body: JSON.stringify({ email, password }),',
  },
  { type: 'remove', content: '    }).then(r => r.json()).then(data => {' },
  { type: 'remove', content: '      setUser(data.user);' },
  { type: 'remove', content: '      setLoading(false);' },
  { type: 'remove', content: '    });' },
  { type: 'remove', content: '  }' },
  { type: 'add', content: '      });' },
  { type: 'add', content: '      const data = await res.json();' },
  { type: 'add', content: '      setUser(data.user);' },
  { type: 'add', content: '    } finally {' },
  { type: 'add', content: '      setIsLoading(false);' },
  { type: 'add', content: '    }' },
  { type: 'add', content: '  }, []);' },
  { type: 'context', content: '' },
  { type: 'remove', content: '  return { user, loading, login };' },
  { type: 'add', content: '  return { user, isLoading, login };' },
  { type: 'context', content: '}' },
];

export const DiffView: Story = {
  render: () => {
    const additions = DIFF_LINES.filter((l) => l.type === 'add').length;
    const deletions = DIFF_LINES.filter((l) => l.type === 'remove').length;

    return (
      <CodeBlock
        code={DIFF_LINES.map((l) => l.content).join('\n')}
        language="typescript"
        collapsible={false}
        renderContent={false}
      >
        <CodeBlockHeader>
          <CodeBlockTitle>
            <CodeBlockDiff
              path="src/hooks/useAuth.ts"
              additions={additions}
              deletions={deletions}
            />
          </CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockDiffContent lines={DIFF_LINES} language="typescript" />
      </CodeBlock>
    );
  },
};

// ---------------------------------------------------------------------------
// Language Selector
// ---------------------------------------------------------------------------

export const WithLanguageSelector: Story = {
  render: () => (
    <CodeBlock code={TS_CODE} language="typescript" showLineNumbers>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>useAuth.ts</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockLanguageSelector defaultValue="typescript">
            <CodeBlockLanguageSelectorTrigger>
              <CodeBlockLanguageSelectorValue />
            </CodeBlockLanguageSelectorTrigger>
            <CodeBlockLanguageSelectorContent>
              <CodeBlockLanguageSelectorItem value="typescript">
                TypeScript
              </CodeBlockLanguageSelectorItem>
              <CodeBlockLanguageSelectorItem value="javascript">
                JavaScript
              </CodeBlockLanguageSelectorItem>
              <CodeBlockLanguageSelectorItem value="python">
                Python
              </CodeBlockLanguageSelectorItem>
            </CodeBlockLanguageSelectorContent>
          </CodeBlockLanguageSelector>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
};

// ---------------------------------------------------------------------------
// Long Code (scroll)
// ---------------------------------------------------------------------------

export const LongCode: Story = {
  name: 'Long Code (scrollable)',
  render: () => {
    const longCode = Array.from(
      { length: 100 },
      (_, i) =>
        `// Line ${i + 1}: This is a sample line of code that demonstrates scrolling behavior`,
    ).join('\n');

    return (
      <CodeBlock code={longCode} language="typescript" showLineNumbers>
        <CodeBlockHeader>
          <CodeBlockTitle>
            <CodeBlockFilename>long-file.ts</CodeBlockFilename>
          </CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </CodeBlockHeader>
      </CodeBlock>
    );
  },
};

// ---------------------------------------------------------------------------
// Terminal-style (collapsible + forceDark)
// ---------------------------------------------------------------------------

export const TerminalStyle: Story = {
  name: 'Terminal Style (collapsible + dark)',
  render: () => {
    const output = [
      '$ pnpm test',
      '',
      ' ✓ src/hooks/useAuth.test.ts (3 tests) 45ms',
      ' ✓ src/hooks/useTheme.test.ts (2 tests) 12ms',
      ' ✓ src/components/Button.test.tsx (5 tests) 89ms',
      '',
      ' Test Files  3 passed (3)',
      ' Tests       10 passed (10)',
      ' Start at    18:00:00',
      ' Duration    1.23s',
    ].join('\n');

    return (
      <CodeBlock
        code={output}
        language="bash"
        collapsible
        forceDark
        command="pnpm test"
        showCommandCopy
        showOutputCopy
      >
        <CodeBlockHeader>
          <CodeBlockTitle>
            <CodeBlockCommand>pnpm test</CodeBlockCommand>
          </CodeBlockTitle>
        </CodeBlockHeader>
      </CodeBlock>
    );
  },
};
