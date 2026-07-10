'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { createWSClient, httpBatchLink, splitLink, wsLink } from '@trpc/client';
import superjson from 'superjson';
import { createSandboxServerRpcClient } from '@roomote/sdk/sandbox-router';

import type { SandboxClient } from '../types';

import type { SandboxConnectionTarget } from './use-task-session';

interface ConnectionStateOverride {
  override: SandboxConnectionTarget | null;
  version: number;
}

interface SandboxLiveTransportStore {
  getState(): {
    _setClient: (client: SandboxClient | null) => void;
    _setReconnecting: (reconnecting: boolean) => void;
    _setSandboxToken: (token: string | undefined) => void;
    _setSandboxUrl: (url: string | null) => void;
  };
}

interface UseSandboxLiveTransportOptions {
  taskId: string;
  url: string | undefined | null;
  token: string | undefined;
  store: SandboxLiveTransportStore;
}

interface SandboxLiveTransport {
  client: SandboxClient | null;
  activeUrl: string | undefined | null;
  activeToken: string | undefined;
  urlRef: MutableRefObject<string | undefined | null>;
  tokenRef: MutableRefObject<string | undefined>;
  restartTransport: (connectionTarget?: SandboxConnectionTarget | null) => void;
  transportCloseRef: MutableRefObject<{
    version: number;
    code?: number;
    reason?: string;
  }>;
}

interface TransportCloseState {
  version: number;
  code?: number;
  reason?: string;
}

export function useSandboxLiveTransport({
  taskId,
  url,
  token,
  store,
}: UseSandboxLiveTransportOptions): SandboxLiveTransport {
  const [connectionState, setConnectionState] =
    useState<ConnectionStateOverride>({
      override: null,
      version: 0,
    });
  const activeUrl = connectionState.override?.url ?? url;
  const activeToken = connectionState.override?.token ?? token;
  const urlRef = useRef(activeUrl);
  const tokenRef = useRef(activeToken);
  const wsClientRef = useRef<ReturnType<typeof createWSClient> | null>(null);
  const [wsReady, setWsReady] = useState<{
    url: string;
    version: number;
  } | null>(null);
  const transportCloseRef = useRef<TransportCloseState>({
    version: connectionState.version,
  });

  urlRef.current = activeUrl;
  tokenRef.current = activeToken;

  useEffect(() => {
    setConnectionState({
      override: null,
      version: 0,
    });
    store.getState()._setReconnecting(false);
  }, [store, taskId]);

  useEffect(() => {
    if (
      connectionState.override &&
      connectionState.override.url === url &&
      connectionState.override.token === token
    ) {
      setConnectionState((current) =>
        current.override &&
        current.override.url === url &&
        current.override.token === token
          ? {
              ...current,
              override: null,
            }
          : current,
      );
    }
  }, [connectionState.override, token, url]);

  useEffect(() => {
    if (!activeUrl || !activeToken) {
      setWsReady(null);
      return;
    }

    const wsUrl = activeUrl.replace(/^http/, 'ws') + '/ws/trpc';
    const transportVersion = connectionState.version;
    transportCloseRef.current = { version: transportVersion };

    const recordTransportClose = (
      closeState: Omit<Partial<TransportCloseState>, 'version'>,
    ) => {
      if (transportCloseRef.current.version !== transportVersion) {
        return;
      }

      transportCloseRef.current = {
        ...transportCloseRef.current,
        ...closeState,
      };
    };

    const ws = createWSClient({
      url: wsUrl,
      connectionParams: () =>
        tokenRef.current ? { token: tokenRef.current } : {},
      onClose: (cause) => {
        recordTransportClose({
          code: cause?.code,
        });
      },
      onError: () => {
        recordTransportClose({
          reason: 'websocket error event',
        });
      },
    });

    wsClientRef.current = ws;
    setWsReady({ url: activeUrl, version: connectionState.version });

    return () => {
      ws.close();
      wsClientRef.current = null;
      setWsReady(null);
    };
  }, [activeToken, activeUrl, connectionState.version]);

  const client = useMemo(() => {
    if (!wsReady || !wsClientRef.current) {
      return null;
    }

    return createSandboxServerRpcClient({
      links: [
        splitLink({
          condition: (op) => op.type === 'subscription',
          true: wsLink({
            client: wsClientRef.current,
            transformer: superjson,
          }),
          false: httpBatchLink({
            url: `${wsReady.url}/trpc`,
            transformer: superjson,
            headers: () =>
              tokenRef.current
                ? { Authorization: `Bearer ${tokenRef.current}` }
                : {},
          }),
        }),
      ],
    });
  }, [wsReady]);

  useEffect(() => store.getState()._setClient(client), [store, client]);

  useEffect(
    () => store.getState()._setSandboxUrl(activeUrl ?? null),
    [store, activeUrl],
  );

  useEffect(
    () => store.getState()._setSandboxToken(activeToken),
    [store, activeToken],
  );

  const restartTransport = useCallback(
    (connectionTarget?: SandboxConnectionTarget | null) => {
      setConnectionState((current) => ({
        override: connectionTarget ?? current.override,
        version: current.version + 1,
      }));
    },
    [],
  );

  return {
    client,
    activeToken,
    activeUrl,
    tokenRef,
    transportCloseRef,
    urlRef,
    restartTransport,
  };
}
