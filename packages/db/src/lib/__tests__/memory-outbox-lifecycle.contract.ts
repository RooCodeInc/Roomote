export type MemoryOutboxContractRow = {
  id: string;
  revision: number;
  attempts: number;
  status: 'pending' | 'processing' | 'done' | 'skipped' | 'failed';
  lastError: string | null;
  processedAt: Date | null;
};

export type MemoryOutboxContractHarness = {
  createEvent: () => Promise<MemoryOutboxContractRow>;
  claim: () => Promise<MemoryOutboxContractRow[]>;
  release: (ids: string[]) => Promise<void>;
  mark: (
    id: string,
    status: 'pending' | 'skipped',
    lastError?: string,
  ) => Promise<void>;
  settle: (
    id: string,
    revision: number,
    outcome: 'done' | 'failed',
    lastError?: string,
  ) => Promise<'settled' | 'superseded'>;
  revise: () => Promise<void>;
  age: (id: string) => Promise<void>;
  read: (id: string) => Promise<MemoryOutboxContractRow>;
};

/** Exercise the lifecycle contract shared by every revision-fenced outbox. */
export function runMemoryOutboxLifecycleContract(
  name: string,
  createHarness: () => MemoryOutboxContractHarness,
): void {
  describe(`${name} shared outbox lifecycle`, () => {
    let harness: MemoryOutboxContractHarness;

    beforeEach(() => {
      harness = createHarness();
    });

    it('claims once, reclaims stale work, and refunds released attempts', async () => {
      await expect(harness.release([])).resolves.toBeUndefined();

      const event = await harness.createEvent();
      const [claimed] = await harness.claim();

      expect(claimed).toMatchObject({ id: event.id, attempts: 1 });
      expect(await harness.claim()).toHaveLength(0);

      await harness.age(event.id);
      const [staleReclaim] = await harness.claim();
      expect(staleReclaim).toMatchObject({ id: event.id, attempts: 2 });

      await harness.release([event.id]);
      expect(await harness.read(event.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
      });
    });

    it('guards skipped transitions and revision-fences terminal settlement', async () => {
      const event = await harness.createEvent();

      await harness.mark(event.id, 'skipped', 'not claimed');
      expect(await harness.read(event.id)).toMatchObject({ status: 'pending' });

      const [claimed] = await harness.claim();
      await harness.revise();
      expect(await harness.settle(event.id, claimed!.revision, 'done')).toBe(
        'superseded',
      );
      expect(await harness.read(event.id)).toMatchObject({
        status: 'pending',
        processedAt: null,
      });

      const [reclaimed] = await harness.claim();
      expect(await harness.settle(event.id, reclaimed!.revision, 'done')).toBe(
        'settled',
      );
      expect((await harness.read(event.id)).processedAt).not.toBeNull();
    });

    it('requeues after a stale writer returns behind a newer settlement', async () => {
      const event = await harness.createEvent();
      const [claimedA] = await harness.claim();
      await harness.revise();
      await harness.age(event.id);

      const [claimedB] = await harness.claim();
      expect(claimedB!.revision).toBeGreaterThan(claimedA!.revision);
      expect(await harness.settle(event.id, claimedB!.revision, 'done')).toBe(
        'settled',
      );

      expect(await harness.settle(event.id, claimedA!.revision, 'done')).toBe(
        'superseded',
      );
      expect(await harness.read(event.id)).toMatchObject({
        status: 'pending',
        processedAt: null,
      });
    });

    it('records terminal failures without stamping successful processing time', async () => {
      const event = await harness.createEvent();
      const [claimed] = await harness.claim();

      await harness.settle(event.id, claimed!.revision, 'failed', 'poison row');

      expect(await harness.read(event.id)).toMatchObject({
        status: 'failed',
        lastError: 'poison row',
        processedAt: null,
      });
    });
  });
}
