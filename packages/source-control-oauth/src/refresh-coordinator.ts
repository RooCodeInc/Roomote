const DEFINITIVE_OAUTH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
]);

export type OAuthRefreshConnection = {
  accessToken: string;
  expiresAt: string;
  status: 'active' | 'reauthorization_required';
};

export type OAuthRefreshOptions = {
  forceRefresh?: boolean;
};

export class OAuthRefreshError extends Error {
  readonly definitive: boolean;

  constructor(message: string, definitive: boolean) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.definitive = definitive;
  }
}

export function isDefinitiveOAuthErrorCode(error: string | undefined): boolean {
  return DEFINITIVE_OAUTH_ERRORS.has(error ?? '');
}

export async function readOAuthErrorCode(
  response: Response,
): Promise<string | undefined> {
  return response
    .clone()
    .json()
    .then((body) => (body as { error?: string }).error)
    .catch(() => undefined);
}

type OAuthRefreshCoordinatorConfig<
  Connection extends OAuthRefreshConnection,
  Result,
  Options extends OAuthRefreshOptions,
> = {
  readConnection: () => Promise<Connection | null>;
  writeConnection: (connection: Connection) => Promise<void>;
  deleteConnection: () => Promise<void>;
  isFresh: (connection: Connection) => boolean;
  refresh: (
    connection: Connection,
    options: Options | undefined,
  ) => Promise<Connection>;
  toResult: (connection: Connection) => Result;
  retainPreviousAccessToken?: boolean;
};

export type OAuthRefreshCoordinator<
  Connection extends OAuthRefreshConnection,
  Result,
  Options extends OAuthRefreshOptions,
> = {
  delete: () => Promise<void>;
  isAccessToken: (token: string) => boolean;
  remember: (connection: Connection) => void;
  resolve: (options?: Options) => Promise<Result | null>;
};

export function createOAuthRefreshCoordinator<
  Connection extends OAuthRefreshConnection,
  Result,
  Options extends OAuthRefreshOptions,
>(
  config: OAuthRefreshCoordinatorConfig<Connection, Result, Options>,
): OAuthRefreshCoordinator<Connection, Result, Options> {
  let refreshPromise: Promise<Result | null> | null = null;
  let deletionPromise: Promise<void> | null = null;
  let connectionGeneration = 0;
  let accessToken: string | null = null;
  let previousAccessToken: string | null = null;

  function rememberAccessToken(connection: Connection): void {
    if (
      config.retainPreviousAccessToken &&
      accessToken &&
      accessToken !== connection.accessToken
    ) {
      previousAccessToken = accessToken;
    }
    accessToken = connection.accessToken;
  }

  function remember(connection: Connection): void {
    connectionGeneration += 1;
    rememberAccessToken(connection);
  }

  function resultFor(connection: Connection): Result {
    rememberAccessToken(connection);
    return config.toResult(connection);
  }

  async function deleteConnection(): Promise<void> {
    if (!deletionPromise) {
      connectionGeneration += 1;
      const inFlightRefresh = refreshPromise;
      deletionPromise = (async () => {
        await inFlightRefresh?.catch(() => undefined);
        await config.deleteConnection();
        refreshPromise = null;
        accessToken = null;
        previousAccessToken = null;
      })();
    }

    const pendingDeletion = deletionPromise;
    try {
      await pendingDeletion;
    } finally {
      if (deletionPromise === pendingDeletion) deletionPromise = null;
    }
  }

  async function resolve(options?: Options): Promise<Result | null> {
    if (deletionPromise) {
      await deletionPromise;
      return null;
    }

    const generation = connectionGeneration;
    const connection = await config.readConnection();
    if (generation !== connectionGeneration || deletionPromise) {
      await deletionPromise;
      return null;
    }
    if (!connection || connection.status !== 'active') return null;
    if (!options?.forceRefresh && config.isFresh(connection)) {
      return resultFor(connection);
    }
    if (refreshPromise) return refreshPromise;

    const pendingRefresh = (async () => {
      try {
        const next = await config.refresh(connection, options);
        if (generation !== connectionGeneration) return null;
        await config.writeConnection(next);
        return resultFor(next);
      } catch (error) {
        if (!(error instanceof OAuthRefreshError) || !error.definitive) {
          throw error;
        }
        if (generation !== connectionGeneration) return null;

        const latest = await config.readConnection();
        if (generation !== connectionGeneration) return null;
        if (
          latest?.status === 'active' &&
          latest.accessToken !== connection.accessToken &&
          config.isFresh(latest)
        ) {
          return resultFor(latest);
        }

        await config.writeConnection({
          ...(latest ?? connection),
          status: 'reauthorization_required',
        });
        throw error;
      }
    })();
    refreshPromise = pendingRefresh;

    try {
      return await pendingRefresh;
    } finally {
      if (refreshPromise === pendingRefresh) refreshPromise = null;
    }
  }

  return {
    delete: deleteConnection,
    isAccessToken: (token) =>
      Boolean(token) &&
      (token === accessToken || token === previousAccessToken),
    remember,
    resolve,
  };
}
