import { render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  markRead: vi.fn(),
  presence: vi.fn(),
  browserAttention: vi.fn(() => ({ prompt: null })),
}));

vi.mock('@/hooks/useMarkSessionRead', () => ({
  useMarkSessionRead: mocks.markRead,
}));
vi.mock('@/hooks/useSessionPresence', () => ({
  useSessionPresence: mocks.presence,
}));
vi.mock('@/hooks/useSessionBrowserAttention', () => ({
  useSessionBrowserAttention: mocks.browserAttention,
}));

import { TaskSessionReadTracker } from './TaskSessionReadTracker';

it('tracks focused and page-open attention presence for the task Session', () => {
  render(<TaskSessionReadTracker sessionId="session-1" />);
  expect(mocks.markRead).toHaveBeenCalledWith('session-1');
  expect(mocks.presence).toHaveBeenCalledWith('session-1');
  expect(mocks.browserAttention).toHaveBeenCalledWith('session-1');
});
