import {
  engageCredentialWriteBarrier,
  isCredentialWriteBarrierEngaged,
  resetCredentialWriteBarrierForTesting,
  runUnlessCredentialWriteBarrier,
} from './credential-write-barrier';

describe('credential write barrier', () => {
  beforeEach(() => {
    resetCredentialWriteBarrierForTesting();
  });

  it('runs writes and returns their result while disengaged', async () => {
    const result = await runUnlessCredentialWriteBarrier(async () => 'written');

    expect(result).toBe('written');
    expect(isCredentialWriteBarrierEngaged()).toBe(false);
  });

  it('skips writes without invoking them once engaged', async () => {
    await engageCredentialWriteBarrier();

    const work = vi.fn(async () => 'written');
    const result = await runUnlessCredentialWriteBarrier(work);

    expect(result).toBeNull();
    expect(work).not.toHaveBeenCalled();
  });

  it('waits for in-flight writes to settle before engaging', async () => {
    let finishWrite!: () => void;
    let writeSettled = false;

    const pendingWrite = runUnlessCredentialWriteBarrier(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            writeSettled = true;
            resolve();
          };
        }),
    );

    let engaged = false;
    const engagement = engageCredentialWriteBarrier().then(() => {
      engaged = true;
    });

    // The barrier must not report engaged-and-drained while a write is
    // still pending.
    await Promise.resolve();
    expect(engaged).toBe(false);
    expect(isCredentialWriteBarrierEngaged()).toBe(true);

    finishWrite();
    await engagement;
    await pendingWrite;

    expect(engaged).toBe(true);
    expect(writeSettled).toBe(true);
  });

  it('drains failed writes without rejecting the engagement', async () => {
    const failingWrite = runUnlessCredentialWriteBarrier(async () => {
      throw new Error('write exploded');
    });

    await expect(engageCredentialWriteBarrier()).resolves.toBeUndefined();
    await expect(failingWrite).rejects.toThrow('write exploded');
  });
});
