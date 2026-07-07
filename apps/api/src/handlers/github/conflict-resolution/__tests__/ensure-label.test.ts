import { AUTO_RESOLVE_CONFLICTS_LABEL } from '../constants';
import { ensureConflictLabel, addConflictLabelToPr } from '../ensure-label';

describe('ensureConflictLabel', () => {
  const mockGetLabel = vi.fn();
  const mockCreateLabel = vi.fn();
  const mockOctokit = {
    rest: {
      issues: {
        getLabel: mockGetLabel,
        createLabel: mockCreateLabel,
        addLabels: vi.fn(),
      },
    },
  } as unknown as Parameters<typeof ensureConflictLabel>[0];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when label already exists', async () => {
    mockGetLabel.mockResolvedValue({
      data: { name: AUTO_RESOLVE_CONFLICTS_LABEL },
    });

    const result = await ensureConflictLabel(mockOctokit, 'owner', 'repo');
    expect(result).toBe(true);
    expect(mockCreateLabel).not.toHaveBeenCalled();
  });

  it('creates label when it does not exist', async () => {
    mockGetLabel.mockRejectedValue({ status: 404 });
    mockCreateLabel.mockResolvedValue({});

    const result = await ensureConflictLabel(mockOctokit, 'owner', 'repo');
    expect(result).toBe(true);
    expect(mockCreateLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: AUTO_RESOLVE_CONFLICTS_LABEL,
        color: '6f42c1',
      }),
    );
  });

  it('returns false when label creation fails', async () => {
    mockGetLabel.mockRejectedValue({ status: 404 });
    mockCreateLabel.mockRejectedValue(new Error('Permission denied'));

    const result = await ensureConflictLabel(mockOctokit, 'owner', 'repo');
    expect(result).toBe(false);
  });
});

describe('addConflictLabelToPr', () => {
  const mockAddLabels = vi.fn();
  const mockOctokit = {
    rest: {
      issues: {
        addLabels: mockAddLabels,
      },
    },
  } as unknown as Parameters<typeof addConflictLabelToPr>[0];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds the label to a PR', async () => {
    mockAddLabels.mockResolvedValue({});

    const result = await addConflictLabelToPr(mockOctokit, 'owner', 'repo', 1);
    expect(result).toBe(true);
    expect(mockAddLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 1,
        labels: [AUTO_RESOLVE_CONFLICTS_LABEL],
      }),
    );
  });

  it('returns false on API error', async () => {
    mockAddLabels.mockRejectedValue(new Error('API error'));

    const result = await addConflictLabelToPr(mockOctokit, 'owner', 'repo', 1);
    expect(result).toBe(false);
  });
});
