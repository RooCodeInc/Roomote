import { setTimeout as delay } from 'node:timers/promises';
import { sdk } from '@roomote/sdk/client';
import type { WorkerEnv } from './worker-env';
import { verifySessionProxyConnection } from './session-proxy';
import { writeSessionProxyEnvFile } from './session-proxy-file';
import {
  isCredentialWriteBarrierEngaged,
  runUnlessCredentialWriteBarrier,
} from '../lib/credential-write-barrier';

export async function syncSessionProxyOnce(
  worker: WorkerEnv,
  file: string,
  signal: AbortSignal,
): Promise<void> {
  const generation = worker.sessionProxyGeneration;
  if (
    worker.sessionEgressAdmissionMode !== 'authenticated_proxy' ||
    !generation
  )
    return;
  if (isCredentialWriteBarrierEngaged()) return;
  const response = await sdk.mcpConnections.syncSessionProxyServices(
    {
      generation,
      heldSubstituteIds: worker.sessionEgressServices.flatMap((service) =>
        service.substituteId ? [service.substituteId] : [],
      ),
    },
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  );
  if ('retryAfterMs' in response) return;
  const applied = await runUnlessCredentialWriteBarrier(async () => {
    signal.throwIfAborted();
    worker.applySessionProxyServices(response);
    await verifySessionProxyConnection(worker);
    signal.throwIfAborted();
    writeSessionProxyEnvFile(file, worker.buildSessionEgressClientEnv());
    return true;
  });
  if (applied) {
    // A lost acknowledgement response must not roll back an applied file.
    // The next synchronization acknowledges the latest revision again.
    await sdk.mcpConnections
      .acknowledgeSessionProxyServices(
        generation,
        response.revision,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      )
      .catch(() => {
        if (!signal.aborted)
          console.warn('[sessionProxy] Apply acknowledgement pending');
      });
  }
}

export async function startSessionProxySync(
  worker: WorkerEnv,
  file: string,
  runSignal: AbortSignal,
): Promise<() => Promise<void>> {
  if (
    worker.sessionEgressAdmissionMode !== 'authenticated_proxy' ||
    !worker.sessionProxyGeneration
  )
    return async () => {};
  const stop = new AbortController();
  const signal = AbortSignal.any([runSignal, stop.signal]);
  worker.setSessionProxyEnvFile(file);
  await runUnlessCredentialWriteBarrier(async () => {
    writeSessionProxyEnvFile(file, worker.buildSessionEgressClientEnv());
  });
  const attempt = async () => {
    try {
      await syncSessionProxyOnce(worker, file, signal);
    } catch {
      await runUnlessCredentialWriteBarrier(async () => {
        writeSessionProxyEnvFile(file, {});
      });
      if (!signal.aborted)
        console.warn(
          '[sessionProxy] Configuration unavailable; no credential fallback is permitted',
        );
    }
  };
  await attempt();
  const loop = (async () => {
    while (!signal.aborted) {
      try {
        await delay(15_000, undefined, { signal });
      } catch {
        break;
      }
      await attempt();
    }
  })();
  return async () => {
    stop.abort();
    await loop;
  };
}
