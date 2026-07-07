import { render, screen } from '@testing-library/react';

vi.mock('@/components/system', () => ({
  ASCIISpinner: () => <span data-testid="spinner">spinner</span>,
}));

vi.mock('@/components/ai-elements', () => ({
  Message: ({
    className,
    children,
  }: {
    className?: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="message" className={className}>
      {children}
    </div>
  ),
  MessageContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@roomote/types', () => ({
  STARTUP_HIDDEN_PREFIXES: [],
}));

import { SandboxLogsTerminal } from './SandboxLogsTerminal';

describe('SandboxLogsTerminal', () => {
  it('is hidden by default and shown under the debug variant', () => {
    render(
      <SandboxLogsTerminal
        logs={[
          {
            data: 'booting',
            stream: 'stdout',
            timestamp: Date.now(),
          },
        ]}
        isConnected={false}
        error={null}
      />,
    );

    expect(screen.getByTestId('message')).toHaveClass('hidden', 'debug:flex');
  });
});
