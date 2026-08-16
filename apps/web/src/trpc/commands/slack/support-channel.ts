import { SlackNotifier } from '@roomote/slack';
import {
  db,
  deploymentSettings,
  desc,
  eq,
  slackInstallations,
  sql,
} from '@roomote/db/server';
import { acquireRedisLock, REDIS_KEYS } from '@roomote/redis';

import type { UserAuthSuccess } from '@/types';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';
import { SLACK_SUPPORT_CHANNEL_BOT_SCOPES } from '@/lib/slack-app-manifest';

const SUPPORT_CHANNEL_METADATA_KEY = 'slackSupportChannel';

type SupportChannelRecord = {
  teamId: string;
  channelId: string;
  channelName: string;
  inviteId?: string;
  inviteSentAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type SlackSupportChannelStatus = {
  eligible: boolean;
  configured: boolean;
  state:
    | 'unavailable'
    | 'not_connected'
    | 'needs_permissions'
    | 'not_started'
    | 'invitation_pending'
    | 'connected'
    | 'action_needed';
  channelId: string | null;
  channelName: string | null;
  openUrl: string | null;
  message: string;
};

function readSupportChannelRecord(
  metadata: unknown,
): SupportChannelRecord | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[
    SUPPORT_CHANNEL_METADATA_KEY
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.channelId !== 'string' ||
    typeof record.teamId !== 'string' ||
    typeof record.channelName !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    teamId: record.teamId,
    channelId: record.channelId,
    channelName: record.channelName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.inviteId === 'string'
      ? { inviteId: record.inviteId }
      : {}),
    ...(typeof record.inviteSentAt === 'string'
      ? { inviteSentAt: record.inviteSentAt }
      : {}),
    ...(typeof record.lastError === 'string'
      ? { lastError: record.lastError }
      : {}),
  };
}

async function getSupportChannelRecord(): Promise<SupportChannelRecord | null> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
    columns: { metadata: true },
  });
  return readSupportChannelRecord(settings?.metadata);
}

async function saveSupportChannelRecord(record: SupportChannelRecord) {
  const metadata = { [SUPPORT_CHANNEL_METADATA_KEY]: record };
  await db
    .insert(deploymentSettings)
    .values({ id: 'default', metadata })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify(metadata)}::jsonb`,
        updatedAt: new Date(),
      },
    });
}

function getBotScopes(scopes: unknown): Set<string> {
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) {
    return new Set();
  }
  const botScopes = (scopes as { bot?: unknown }).bot;
  return new Set(
    Array.isArray(botScopes)
      ? botScopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
  );
}

function hasSupportChannelScopes(scopes: unknown) {
  const granted = getBotScopes(scopes);
  return SLACK_SUPPORT_CHANNEL_BOT_SCOPES.every((scope) => granted.has(scope));
}

function mapSlackError(
  error: string,
): Pick<SlackSupportChannelStatus, 'state' | 'message'> {
  switch (error) {
    case 'missing_scope':
      return {
        state: 'needs_permissions',
        message: 'Update the Slack app permissions and re-authenticate.',
      };
    case 'not_paid':
    case 'not_allowed_for_grid_workspace':
      return {
        state: 'action_needed',
        message: 'This Slack workspace does not support Slack Connect.',
      };
    case 'restricted_action':
    case 'no_external_invite_permission':
    case 'no_permission':
      return {
        state: 'action_needed',
        message: 'A Slack admin must allow external channel invitations.',
      };
    default:
      return {
        state: 'action_needed',
        message: 'Slack could not finish the invitation. Try again.',
      };
  }
}

function withChannel(
  record: SupportChannelRecord | null,
  status: Omit<
    SlackSupportChannelStatus,
    'channelId' | 'channelName' | 'openUrl'
  >,
): SlackSupportChannelStatus {
  return {
    ...status,
    channelId: record?.channelId ?? null,
    channelName: record?.channelName ?? null,
    openUrl: record?.channelId
      ? `https://slack.com/app_redirect?channel=${encodeURIComponent(record.channelId)}`
      : null,
  };
}

async function getActiveSlackInstallation() {
  return db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    orderBy: [desc(slackInstallations.updatedAt)],
  });
}

export async function getSlackSupportChannelStatusCommand(
  auth: UserAuthSuccess,
): Promise<SlackSupportChannelStatus> {
  if (!auth.isAdmin || !isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED)) {
    return withChannel(null, {
      eligible: false,
      configured: false,
      state: 'unavailable',
      message: 'Shared support channels are available on Roomote Cloud.',
    });
  }

  const supportEmail = Env.R_SLACK_CONNECT_SUPPORT_EMAIL?.trim();
  if (!supportEmail) {
    return withChannel(null, {
      eligible: true,
      configured: false,
      state: 'unavailable',
      message: 'Shared support channel setup is not configured.',
    });
  }

  const installation = await getActiveSlackInstallation();
  if (!installation) {
    return withChannel(null, {
      eligible: true,
      configured: true,
      state: 'not_connected',
      message: 'Connect a Slack workspace first.',
    });
  }
  if (!hasSupportChannelScopes(installation.scopes)) {
    return withChannel(null, {
      eligible: true,
      configured: true,
      state: 'needs_permissions',
      message: 'Update the Slack app permissions and re-authenticate.',
    });
  }

  const record = await getSupportChannelRecord();
  if (!record || record.teamId !== installation.teamId) {
    return withChannel(null, {
      eligible: true,
      configured: true,
      state: 'not_started',
      message: 'Create a private Slack Connect channel with Roomote support.',
    });
  }

  const slack = new SlackNotifier(installation.botAccessToken);
  const connectStatus = await slack.getSlackConnectChannelStatus(
    record.channelId,
  );
  if (!connectStatus.success) {
    const mapped = mapSlackError(connectStatus.error);
    return withChannel(record, {
      eligible: true,
      configured: true,
      ...mapped,
    });
  }
  if (connectStatus.data === 'connected') {
    return withChannel(record, {
      eligible: true,
      configured: true,
      state: 'connected',
      message: 'Connected with Roomote support.',
    });
  }
  if (connectStatus.data === 'pending') {
    return withChannel(record, {
      eligible: true,
      configured: true,
      state: 'invitation_pending',
      message: 'Waiting for invite acceptance or Slack admin approval.',
    });
  }

  return withChannel(record, {
    eligible: true,
    configured: true,
    state: 'action_needed',
    message:
      connectStatus.data === 'not_found'
        ? 'The support channel no longer exists. Contact Roomote support.'
        : record.inviteSentAt
          ? 'The previous Slack Connect invitation is no longer pending. Send it again.'
          : record.lastError
            ? mapSlackError(record.lastError).message
            : 'The Slack Connect invitation needs to be sent again.',
  });
}

async function createSlackSupportChannel(
  supportEmail: string,
  ensureLock: () => Promise<boolean>,
): Promise<SlackSupportChannelStatus> {
  const installation = await getActiveSlackInstallation();
  if (!installation) {
    throw new Error('Connect a Slack workspace first.');
  }
  if (!hasSupportChannelScopes(installation.scopes)) {
    return withChannel(null, {
      eligible: true,
      configured: true,
      state: 'needs_permissions',
      message: 'Update the Slack app permissions and re-authenticate.',
    });
  }

  const slack = new SlackNotifier(installation.botAccessToken);
  let record = await getSupportChannelRecord();
  if (record?.teamId !== installation.teamId) {
    record = null;
  }

  if (record) {
    const currentStatus = await slack.getSlackConnectChannelStatus(
      record.channelId,
    );
    if (currentStatus.success && currentStatus.data === 'connected') {
      return withChannel(record, {
        eligible: true,
        configured: true,
        state: 'connected',
        message: 'Connected with Roomote support.',
      });
    }
    if (currentStatus.success && currentStatus.data === 'pending') {
      return withChannel(record, {
        eligible: true,
        configured: true,
        state: 'invitation_pending',
        message: 'Waiting for invite acceptance or Slack admin approval.',
      });
    }
    if (currentStatus.success && currentStatus.data === 'not_found') {
      record = null;
    }
    if (!currentStatus.success) {
      const mapped = mapSlackError(currentStatus.error);
      return withChannel(record, {
        eligible: true,
        configured: true,
        ...mapped,
      });
    }
  }

  if (!record) {
    const channelName = `roomote-support-${installation.teamId
      .slice(-6)
      .toLowerCase()}`;
    let channelId = await slack.resolveChannelId(`#${channelName}`);
    if (!channelId) {
      if (!(await ensureLock())) {
        return withChannel(null, {
          eligible: true,
          configured: true,
          state: 'action_needed',
          message: 'Support channel setup lost its lock. Try again.',
        });
      }
      const created = await slack.createPrivateChannel(channelName);
      if (!created.success && created.error === 'name_taken') {
        channelId = await slack.resolveChannelId(`#${channelName}`);
      } else if (!created.success) {
        const mapped = mapSlackError(created.error);
        return withChannel(null, {
          eligible: true,
          configured: true,
          ...mapped,
        });
      } else {
        channelId = created.data.id;
      }
    }
    if (!channelId) {
      return withChannel(null, {
        eligible: true,
        configured: true,
        state: 'action_needed',
        message:
          'Slack created the channel, but Roomote could not recover it. Try again shortly.',
      });
    }

    const now = new Date().toISOString();
    record = {
      teamId: installation.teamId,
      channelId,
      channelName,
      createdAt: now,
      updatedAt: now,
    };
    await saveSupportChannelRecord(record);
  }

  if (!(await ensureLock())) {
    return withChannel(record, {
      eligible: true,
      configured: true,
      state: 'action_needed',
      message: 'Support channel setup lost its lock. Try again.',
    });
  }
  const invited = await slack.inviteSharedChannel({
    channelId: record.channelId,
    email: supportEmail,
  });
  if (!invited.success) {
    if (invited.error === 'connection_limit_exceeded_pending') {
      return withChannel(record, {
        eligible: true,
        configured: true,
        state: 'invitation_pending',
        message: 'Waiting for invite acceptance or Slack admin approval.',
      });
    }
    const updatedRecord = {
      ...record,
      lastError: invited.error,
      updatedAt: new Date().toISOString(),
    };
    await saveSupportChannelRecord(updatedRecord);
    const mapped = mapSlackError(invited.error);
    return withChannel(updatedRecord, {
      eligible: true,
      configured: true,
      ...mapped,
    });
  }

  const updatedRecord = {
    ...record,
    ...(invited.data.inviteId ? { inviteId: invited.data.inviteId } : {}),
    inviteSentAt: new Date().toISOString(),
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
  await saveSupportChannelRecord(updatedRecord);
  return withChannel(updatedRecord, {
    eligible: true,
    configured: true,
    state: 'invitation_pending',
    message: 'Waiting for invite acceptance or Slack admin approval.',
  });
}

export async function createSlackSupportChannelCommand(
  auth: UserAuthSuccess,
): Promise<SlackSupportChannelStatus> {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
  if (!isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED)) {
    throw new Error('Shared support channels are available on Roomote Cloud.');
  }
  const supportEmail = Env.R_SLACK_CONNECT_SUPPORT_EMAIL?.trim();
  if (!supportEmail) {
    throw new Error('Shared support channel setup is not configured.');
  }

  const lock = await acquireRedisLock(REDIS_KEYS.SLACK_SUPPORT_CHANNEL_CREATE, {
    ttlSeconds: 30,
  });
  if (!lock) {
    return withChannel(await getSupportChannelRecord(), {
      eligible: true,
      configured: true,
      state: 'action_needed',
      message: 'Support channel setup is already in progress. Refresh shortly.',
    });
  }

  let lockLost = false;
  const renewTimer = setInterval(() => {
    void lock.renew().then((renewed) => {
      if (!renewed) lockLost = true;
    });
  }, 10_000);
  renewTimer.unref?.();

  try {
    return await createSlackSupportChannel(supportEmail, async () => {
      if (lockLost) return false;
      const renewed = await lock.renew();
      if (!renewed) lockLost = true;
      return renewed;
    });
  } finally {
    clearInterval(renewTimer);
    await lock();
  }
}
