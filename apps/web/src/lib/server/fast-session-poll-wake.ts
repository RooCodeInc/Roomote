export function createFastSessionPollWake(intervalMs: number) {
  let requested = false;
  let finishWait: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    request(): void {
      requested = true;
      finishWait?.();
    },
    async wait(): Promise<'requested' | 'interval'> {
      if (requested) {
        requested = false;
        return 'requested';
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          timer = undefined;
          finishWait = undefined;
          resolve();
        };
        finishWait = finish;
        timer = setTimeout(finish, intervalMs);
      });
      const result = requested ? 'requested' : 'interval';
      requested = false;
      return result;
    },
    dispose(): void {
      clearTimeout(timer);
      timer = undefined;
      finishWait?.();
      finishWait = undefined;
      requested = false;
    },
  };
}
