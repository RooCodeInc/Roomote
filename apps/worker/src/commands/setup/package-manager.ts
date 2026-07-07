export class AptMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this.createRelease()));
    });
  }

  private createRelease(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;

      const next = this.queue.shift();

      if (next) {
        next();
      } else {
        this.locked = false;
      }
    };
  }
}

const aptMutex = new AptMutex();

export async function withAptLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await aptMutex.acquire();

  try {
    return await fn();
  } finally {
    release();
  }
}
