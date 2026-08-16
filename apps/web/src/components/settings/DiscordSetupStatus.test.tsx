import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactElement,
  ReactNode,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const repairMock = vi.fn();
const queryState = vi.hoisted(() => ({
  channels: [
    {
      id: 'channel-1',
      name: 'roomote',
      type: 0,
      kind: 'text',
      requiresTag: false,
      supported: true,
    },
  ],
  permissions: {
    canUseChannel: true,
    missingPermissions: [] as string[],
    unsupportedReason: null as 'forum_requires_tag' | null,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { kind?: string; enabled?: boolean }) => {
    if (options.kind === 'guilds') {
      return {
        data: {
          guilds: [
            {
              id: 'guild-1',
              name: 'Acme',
              defaultChannelId: 'channel-1',
              defaultChannelName: 'roomote',
              defaultChannelType: 0,
            },
          ],
        },
        isPending: false,
        isError: false,
      };
    }
    if (options.kind === 'channels') {
      return {
        data: { channels: queryState.channels },
        isPending: false,
        isError: false,
      };
    }
    return {
      data: queryState.permissions,
      isPending: false,
      isError: false,
    };
  },
  useMutation: (options: { kind?: string; onSuccess?: () => void }) => ({
    isPending: false,
    mutate: () => {
      if (options.kind === 'repair') repairMock();
      void options.onSuccess?.();
    },
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    comms: {
      status: { queryKey: () => ['status'] },
      listDiscordGuilds: {
        queryOptions: () => ({ kind: 'guilds' }),
        queryKey: () => ['guilds'],
      },
      listDiscordChannels: {
        queryOptions: () => ({ kind: 'channels' }),
      },
      diagnoseDiscordPermissions: {
        queryOptions: () => ({ kind: 'permissions' }),
      },
      selectDiscordDestination: {
        mutationOptions: (options: object) => ({ ...options, kind: 'save' }),
      },
      repairDiscord: {
        mutationOptions: (options: object) => ({ ...options, kind: 'repair' }),
      },
    },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('./DiscordLinkAccountStep', () => ({
  DiscordLinkAccountStep: () => <div>Discord account linking</div>,
}));

vi.mock('@/components/system', () => ({
  Button: ({
    asChild,
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
    children: ReactNode;
  }) => {
    if (asChild) {
      const child = children as ReactElement<
        AnchorHTMLAttributes<HTMLAnchorElement>
      >;
      return <a {...child.props}>{child.props.children}</a>;
    }
    return (
      <button type="button" {...props}>
        {children}
      </button>
    );
  },
  Check: () => <svg aria-hidden="true" />,
  ExternalLink: () => <svg aria-hidden="true" />,
  Info: () => <svg aria-hidden="true" />,
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
  RefreshCw: () => <svg aria-hidden="true" />,
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => <div aria-disabled={disabled}>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  Spinner: () => <span>loading</span>,
  TriangleAlert: () => <svg aria-hidden="true" />,
}));

import { DiscordSetupStatus } from './DiscordSetupStatus';

describe('DiscordSetupStatus', () => {
  beforeEach(() => {
    queryState.channels = [
      {
        id: 'channel-1',
        name: 'roomote',
        type: 0,
        kind: 'text',
        requiresTag: false,
        supported: true,
      },
    ];
    queryState.permissions = {
      canUseChannel: true,
      missingPermissions: [],
      unsupportedReason: null,
    };
  });

  it('shows connected diagnostics, the install link, and repair control', () => {
    render(
      <DiscordSetupStatus
        status={{
          bot: {
            applicationId: 'app-1',
            applicationName: 'Roomote',
            userId: 'bot-1',
            username: 'roomote',
            displayName: 'Roomote',
            identitySource: 'live',
            errorCode: null,
          },
          inviteUrl: 'https://discord.com/oauth2/authorize?client_id=app-1',
          gateway: {
            phase: 'ready',
            live: true,
            ready: true,
            leader: true,
            configured: true,
            connected: true,
            forwardingReady: true,
            sessionResumed: false,
            queueDepth: 0,
            updatedAt: '2026-07-12T00:00:00.000Z',
          },
          gatewaySession: null,
          messageContentIntent: 'enabled',
          commands: {
            status: 'registered',
            names: ['help', 'link', 'new'],
          },
          installations: [
            {
              guildId: 'guild-1',
              guildName: 'Acme',
              defaultChannelId: 'channel-1',
              defaultChannelName: 'roomote',
              defaultChannelType: 0,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(/Connected as @roomote/)).toBeInTheDocument();
    expect(screen.getByText(/receiving Discord events/)).toBeInTheDocument();
    expect(
      screen.getByText(/\/new, \/goal, \/fast, \/link, and \/help/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Add to Discord/i }),
    ).toHaveAttribute(
      'href',
      'https://discord.com/oauth2/authorize?client_id=app-1',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Repair' }));
    expect(repairMock).toHaveBeenCalledOnce();
  });

  it('shows the default channel picker once the bot identity is ready', () => {
    render(
      <DiscordSetupStatus
        status={{
          bot: {
            applicationId: 'app-1',
            applicationName: 'Roomote',
            userId: 'bot-1',
            username: 'roomote',
            displayName: 'Roomote',
            identitySource: 'live',
            errorCode: null,
          },
          inviteUrl: 'https://discord.com/oauth2/authorize?client_id=app-1',
          gateway: null,
          gatewaySession: null,
          messageContentIntent: 'enabled',
          commands: { status: 'registered', names: ['help', 'link', 'new'] },
          installations: [],
        }}
      />,
    );

    expect(screen.getByText('Default channel')).toBeInTheDocument();
    expect(
      screen.getByText(/Currently posting to #roomote/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Discord is still connecting.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Gateway service/i)).not.toBeInTheDocument();
    expect(screen.getByText('Discord account linking')).toBeInTheDocument();
  });

  it('shows quarantined events as delivery history instead of a current failure', () => {
    render(
      <DiscordSetupStatus
        status={{
          bot: {
            applicationId: 'app-1',
            applicationName: 'Roomote',
            userId: 'bot-1',
            username: 'roomote',
            displayName: 'Roomote',
            identitySource: 'live',
            errorCode: null,
          },
          inviteUrl: null,
          gateway: {
            phase: 'ready',
            live: true,
            ready: true,
            leader: true,
            configured: true,
            connected: true,
            forwardingReady: true,
            sessionResumed: false,
            queueDepth: 0,
            deadLetterDepth: 1,
            updatedAt: '2026-07-12T00:00:00.000Z',
          },
          gatewaySession: null,
          messageContentIntent: 'enabled',
          commands: { status: 'registered', names: ['help', 'link', 'new'] },
          installations: [],
        }}
      />,
    );

    expect(screen.getByText(/Event delivery history:/)).toBeInTheDocument();
    expect(
      screen.getByText('1 undeliverable event was quarantined.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/recent messages/i)).not.toBeInTheDocument();
  });
});
