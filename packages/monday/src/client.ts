import type {
  MondayAccount,
  MondayExternalAgentCredentials,
  MondayItemContext,
} from './types';

export const MONDAY_API_URL = 'https://api.monday.com/v2';
export const MONDAY_AGENTS_API_VERSION = 'dev';
const MONDAY_API_TIMEOUT_MS = 45_000;

type GraphQlError = { message?: string };
type GraphQlResponse<T> = { data?: T; errors?: GraphQlError[] };

export type MondayClientOptions = {
  token: string;
  fetch?: typeof globalThis.fetch;
  apiUrl?: string;
};

export class MondayApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MondayApiError';
  }
}

export class MondayClient {
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly apiUrl: string;

  constructor(options: MondayClientOptions) {
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiUrl = options.apiUrl ?? MONDAY_API_URL;
  }

  private async request<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: this.token,
        'API-Version': MONDAY_AGENTS_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(MONDAY_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new MondayApiError(
        `monday.com API request failed with status ${response.status}`,
        response.status,
      );
    }

    const body = (await response.json()) as GraphQlResponse<T>;
    if (body.errors?.length || !body.data) {
      throw new MondayApiError(
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join('; ') || 'monday.com API returned no data',
      );
    }

    return body.data;
  }

  async getAccount(): Promise<MondayAccount> {
    const data = await this.request<{
      me: { account: { id: string; name: string; slug?: string | null } };
    }>(`query RoomoteMondayAccount {
      me { account { id name slug } }
    }`);

    return {
      id: String(data.me.account.id),
      name: data.me.account.name,
      slug: data.me.account.slug ?? null,
    };
  }

  async connectExternalAgent(input: {
    name: string;
    callbackUrl: string;
  }): Promise<MondayExternalAgentCredentials> {
    const data = await this.request<{
      connect_external_agent_sync: {
        agent_id: string;
        api_token: string;
        signing_secret: string;
        instructions?: string | null;
      };
    }>(
      `mutation RoomoteConnectExternalAgent($input: ConnectExternalAgentSyncInput!) {
        connect_external_agent_sync(input: $input) {
          agent_id
          api_token
          signing_secret
          instructions
        }
      }`,
      {
        input: {
          custom: { name: input.name, callback_url: input.callbackUrl },
        },
      },
    );
    const result = data.connect_external_agent_sync;

    return {
      agentId: String(result.agent_id),
      apiToken: result.api_token,
      signingSecret: result.signing_secret,
      instructions: result.instructions ?? null,
    };
  }

  async activateAgent(agentId: string): Promise<void> {
    const data = await this.request<{ activate_agent: { success: boolean } }>(
      `mutation RoomoteActivateAgent($id: ID!) {
        activate_agent(id: $id) { success }
      }`,
      { id: agentId },
    );
    if (!data.activate_agent.success) {
      throw new MondayApiError('monday.com did not activate the agent');
    }
  }

  async deactivateAgent(agentId: string): Promise<void> {
    const data = await this.request<{
      deactivate_agent: { success: boolean };
    }>(
      `mutation RoomoteDeactivateAgent($id: ID!) {
        deactivate_agent(id: $id, inactive_reason: DEACTIVATED_BY_USER) { success }
      }`,
      { id: agentId },
    );
    if (!data.deactivate_agent.success) {
      throw new MondayApiError('monday.com did not deactivate the agent');
    }
  }

  async disconnectExternalAgent(agentId: string): Promise<void> {
    const data = await this.request<{
      disconnect_external_agent: { success: boolean };
    }>(
      `mutation RoomoteDisconnectExternalAgent($id: ID!) {
        disconnect_external_agent(id: $id) { success }
      }`,
      { id: agentId },
    );
    if (!data.disconnect_external_agent.success) {
      throw new MondayApiError('monday.com did not disconnect the agent');
    }
  }

  async getItemContext(itemId: string): Promise<MondayItemContext | null> {
    const data = await this.request<{
      items: Array<{
        id: string;
        name: string;
        board?: { id: string; name: string } | null;
        updates?: Array<{
          id: string;
          body: string;
          created_at: string;
          creator?: { id: string; name: string } | null;
        }>;
      }>;
    }>(
      `query RoomoteMondayItem($ids: [ID!]!) {
        items(ids: $ids) {
          id
          name
          board { id name }
          updates(limit: 25) { id body created_at creator { id name } }
        }
      }`,
      { ids: [itemId] },
    );
    const item = data.items[0];
    if (!item) return null;

    return {
      id: String(item.id),
      name: item.name,
      board: item.board
        ? { id: String(item.board.id), name: item.board.name }
        : null,
      updates: (item.updates ?? []).map((update) => ({
        id: String(update.id),
        body: update.body,
        createdAt: update.created_at,
        creator: update.creator
          ? { id: String(update.creator.id), name: update.creator.name }
          : null,
      })),
    };
  }

  async createUpdate(itemId: string, body: string): Promise<string> {
    const data = await this.request<{ create_update: { id: string } }>(
      `mutation RoomoteCreateUpdate($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) { id }
      }`,
      { itemId, body },
    );
    return String(data.create_update.id);
  }
}
