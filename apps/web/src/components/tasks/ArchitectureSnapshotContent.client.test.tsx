import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { createMermaidPluginMock } = vi.hoisted(() => ({
  createMermaidPluginMock: vi.fn(() => ({ name: 'strict-mermaid' })),
}));

vi.mock('@streamdown/mermaid', () => ({
  createMermaidPlugin: createMermaidPluginMock,
}));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: ReactNode }) => (
    <div data-testid="mermaid-source">{children}</div>
  ),
}));

vi.mock('@/components/system', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import {
  ArchitectureSnapshotContent,
  architectureSnapshotMermaidConfig,
  toMermaidMarkdown,
} from './ArchitectureSnapshotContent';

const snapshot = JSON.stringify({
  schemaVersion: 1,
  title: 'Artifact publication flow',
  mermaid: 'flowchart LR\n  Agent --> API --> Store',
  sources: [
    {
      repository: 'RooCodeInc/Roomote',
      path: 'apps/api/src/handlers/artifacts/create.ts',
      lineStart: 71,
      lineEnd: 104,
      description: 'Creates the versioned record.',
    },
  ],
});

describe('ArchitectureSnapshotContent', () => {
  it('labels generated evidence and shows useful source references', () => {
    render(<ArchitectureSnapshotContent content={snapshot} />);

    expect(screen.getByText('Generated explanatory evidence')).toBeVisible();
    expect(
      screen.getByText(/not authoritative architecture documentation/i),
    ).toBeVisible();
    expect(screen.getByText('Contract v1')).toBeVisible();
    expect(screen.getByText('RooCodeInc/Roomote')).toBeVisible();
    expect(
      screen.getByText('apps/api/src/handlers/artifacts/create.ts:71-104'),
    ).toBeVisible();
    expect(screen.getByText('Creates the versioned record.')).toBeVisible();
  });

  it('uses strict Mermaid rendering', () => {
    render(<ArchitectureSnapshotContent content={snapshot} />);

    expect(architectureSnapshotMermaidConfig).toEqual({
      securityLevel: 'strict',
      suppressErrorRendering: true,
    });
    expect(screen.getByTestId('mermaid-source')).toHaveTextContent(
      'flowchart LR Agent --> API --> Store',
    );
  });

  it('contains backticks in a fence that Mermaid source cannot escape', () => {
    const markdown = toMermaidMarkdown('flowchart LR\n```\nA --> B');

    expect(markdown.startsWith('````mermaid\n')).toBe(true);
    expect(markdown.endsWith('\n````')).toBe(true);
  });

  it('does not render invalid content as Mermaid', () => {
    render(
      <ArchitectureSnapshotContent content='{"schemaVersion":1,"mermaid":"graph"}' />,
    );

    expect(screen.getByText('Architecture snapshot unavailable')).toBeVisible();
    expect(screen.queryByTestId('mermaid-source')).not.toBeInTheDocument();
  });
});
