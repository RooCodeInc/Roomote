import { cleanupModalInstance } from './cleanup';

describe('cleanupModalInstance', () => {
  it('emits destroy events with the logical vendor of the compute client', async () => {
    const onMutation = vi.fn();

    await cleanupModalInstance({
      computeClient: {
        vendor: 'roomote',
        destroyInstance: vi.fn().mockResolvedValue(undefined),
      },
      instanceId: 'modal-123',
      phase: 'spawn_worker',
      error: new Error('bootstrap failed'),
      logPrefix: 'test',
      onMutation,
    });

    expect(onMutation).toHaveBeenCalledTimes(2);
    for (const [event] of onMutation.mock.calls) {
      expect(event.provider).toBe('roomote');
      expect(event.operation).toBe('destroy_instance');
    }
  });

  it('emits a failed destroy event with the logical vendor when cleanup throws', async () => {
    const onMutation = vi.fn();

    await cleanupModalInstance({
      computeClient: {
        vendor: 'roomote',
        destroyInstance: vi.fn().mockRejectedValue(new Error('gone')),
      },
      instanceId: 'modal-123',
      phase: 'spawn_worker',
      error: new Error('bootstrap failed'),
      logPrefix: 'test',
      onMutation,
    });

    const events = onMutation.mock.calls.map(([event]) => event);
    expect(events.some((event) => event.eventType === 'failed')).toBe(true);
    for (const event of events) {
      expect(event.provider).toBe('roomote');
    }
  });
});
