// The orphaned-run cancel note helper must NEVER throw: the callers embed its
// note into the loud lost-finalize warn, and a cancel failure must not mask
// that warn (the orphan diagnosis matters more than the cleanup).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelTaskRunDirectMock } = vi.hoisted(() => ({
  cancelTaskRunDirectMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  cancelTaskRunDirect: cancelTaskRunDirectMock,
}));

import { cancelOrphanedWorkItemRunBestEffort } from '../orphaned-work-item-run.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cancelOrphanedWorkItemRunBestEffort', () => {
  it('cancels the run pre-sandbox and reports success', async () => {
    cancelTaskRunDirectMock.mockResolvedValue(true);

    await expect(cancelOrphanedWorkItemRunBestEffort(123)).resolves.toBe(
      'orphaned run canceled',
    );
    expect(cancelTaskRunDirectMock).toHaveBeenCalledWith({
      runId: 123,
      error: 'Canceled: work-item launch finalize lost the claim fencing guard',
    });
  });

  it('reports when the guarded cancel did not apply (run already started)', async () => {
    cancelTaskRunDirectMock.mockResolvedValue(false);

    await expect(cancelOrphanedWorkItemRunBestEffort(123)).resolves.toBe(
      'orphaned run cancel did not apply (already started or terminal)',
    );
  });

  it('never throws: a cancel failure becomes a note instead of masking the warn', async () => {
    cancelTaskRunDirectMock.mockRejectedValue(new Error('db unavailable'));

    await expect(cancelOrphanedWorkItemRunBestEffort(123)).resolves.toBe(
      'orphaned run cancel failed: db unavailable',
    );
  });
});
