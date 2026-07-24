const { mockUpdateBackgroundAutomationSlackThreadMetadata, mockWarn } =
  vi.hoisted(() => ({
    mockUpdateBackgroundAutomationSlackThreadMetadata: vi.fn(),
    mockWarn: vi.fn(),
  }));

vi.mock('@roomote/db/server', () => ({
  db: {},
  updateBackgroundAutomationSlackThreadMetadata:
    mockUpdateBackgroundAutomationSlackThreadMetadata,
}));

import { finalizeAutomationLaunch } from '../post-launch-finalization';

const params = {
  conversation: {
    provider: 'slack' as const,
    channelId: 'C123',
    rootMessageId: '1781300000.000100',
  },
  taskId: 'task-1',
  context: '[test-automation]',
  warn: mockWarn,
};

describe('finalizeAutomationLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attaches a Slack automation root to the launched task', async () => {
    mockUpdateBackgroundAutomationSlackThreadMetadata.mockResolvedValue(true);

    await expect(finalizeAutomationLaunch(params)).resolves.toEqual({
      attached: true,
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns without failing the launch when attachment is unavailable', async () => {
    mockUpdateBackgroundAutomationSlackThreadMetadata.mockResolvedValue(false);

    await expect(finalizeAutomationLaunch(params)).resolves.toEqual({
      attached: false,
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Could not link Slack thread'),
    );
  });

  it('warns without failing the launch when attachment throws', async () => {
    mockUpdateBackgroundAutomationSlackThreadMetadata.mockRejectedValue(
      new Error('metadata unavailable'),
    );

    await expect(finalizeAutomationLaunch(params)).resolves.toEqual({
      attached: false,
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('metadata unavailable'),
    );
  });
});
