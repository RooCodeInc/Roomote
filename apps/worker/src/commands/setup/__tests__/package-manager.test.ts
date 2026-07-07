import { AptMutex } from '../package-manager';

describe('AptMutex', () => {
  it('serializes concurrent acquires in FIFO order', async () => {
    const mutex = new AptMutex();
    const events: string[] = [];

    const firstRelease = await mutex.acquire();
    const secondAcquire = mutex.acquire().then((release) => {
      events.push('second');
      return release;
    });
    const thirdAcquire = mutex.acquire().then((release) => {
      events.push('third');
      return release;
    });

    await Promise.resolve();
    expect(events).toEqual([]);

    firstRelease();
    const secondRelease = await secondAcquire;
    expect(events).toEqual(['second']);

    secondRelease();
    const thirdRelease = await thirdAcquire;
    expect(events).toEqual(['second', 'third']);

    thirdRelease();
  });

  it('release hands the lock to the next waiter', async () => {
    const mutex = new AptMutex();

    const firstRelease = await mutex.acquire();
    let secondStarted = false;
    const secondAcquire = mutex.acquire().then((release) => {
      secondStarted = true;
      return release;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);

    firstRelease();
    const secondRelease = await secondAcquire;
    expect(secondStarted).toBe(true);

    secondRelease();

    const thirdRelease = await mutex.acquire();
    thirdRelease();
  });

  it('ignores double release calls', async () => {
    const mutex = new AptMutex();

    const firstRelease = await mutex.acquire();
    const secondAcquire = mutex.acquire();

    firstRelease();
    firstRelease();

    const secondRelease = await secondAcquire;
    secondRelease();
  });
});
