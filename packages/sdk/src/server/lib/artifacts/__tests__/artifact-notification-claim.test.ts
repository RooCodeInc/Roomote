import { claimArtifactNotificationDelivery } from '../artifact-notification-claim';

function interleavedRelease() {
  const returning = vi.fn().mockResolvedValue([]);
  const findFirst = vi.fn().mockResolvedValue({ result: {} });
  const tx = {
    update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
    query: { taskRuns: { findFirst } },
  };
  return { tx, returning, findFirst };
}

it('retries ownership when a legacy claim disappears after the conditional update', async () => {
  const { tx, returning, findFirst } = interleavedRelease();
  returning.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 42 }]);
  await expect(
    claimArtifactNotificationDelivery(tx as never, 42, 'synthetic-artifact'),
  ).resolves.toEqual({ status: 'queued' });
  expect(returning).toHaveBeenCalledTimes(2);
  expect(findFirst).toHaveBeenCalledTimes(1);
});

it('does not acknowledge delivery when ownership repeatedly changes during admission', async () => {
  const { tx, returning } = interleavedRelease();
  await expect(
    claimArtifactNotificationDelivery(tx as never, 42, 'synthetic-artifact'),
  ).rejects.toThrow('retry confirmation');
  expect(returning).toHaveBeenCalledTimes(3);
});
