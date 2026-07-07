import { eq } from 'drizzle-orm';

import type { CreateDeploymentSettings, CreateUser } from '../types';
import { deploymentSettings, users } from '../schema';
import { db } from '../db';

import { userFactory } from './factories';

const deploymentSettingsId = 'default';
const localUserId = 'local-user';
const localEmail = 'local@roomote.dev';

const deploymentMetadata = {};

function normalizeMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function setDeploymentPreviewsEnabled(
  metadata: Record<string, unknown>,
  enabled: boolean,
) {
  return {
    ...normalizeMetadataRecord(metadata),
    previews_enabled: enabled,
  };
}

async function seed() {
  console.log('Seeding local Roomote database...');

  const now = new Date();
  const settings: CreateDeploymentSettings = {
    id: deploymentSettingsId,
    metadata: setDeploymentPreviewsEnabled(deploymentMetadata, false),
  };

  const existingSettings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, deploymentSettingsId),
  });

  if (!existingSettings) {
    await db.insert(deploymentSettings).values(settings);
  } else {
    await db
      .update(deploymentSettings)
      .set({
        metadata: {
          ...normalizeMetadataRecord(existingSettings.metadata),
          ...deploymentMetadata,
        },
        updatedAt: now,
      })
      .where(eq(deploymentSettings.id, deploymentSettingsId));
  }

  const localUser: CreateUser = {
    id: localUserId,
    name: 'Local Admin',
    email: localEmail,
    imageUrl: '',
    entity: {
      id: localUserId,
      name: 'Local Admin',
      email: localEmail,
      imageUrl: '',
    },
    metadata: {},
    role: 'admin',
    onboardingCompletedAt: now,
  };

  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, localUserId),
  });

  if (!existingUser) {
    await userFactory.create(localUser);
  } else {
    await db
      .update(users)
      .set({
        name: localUser.name,
        email: localUser.email,
        imageUrl: localUser.imageUrl,
        entity: localUser.entity,
        onboardingCompletedAt: existingUser.onboardingCompletedAt ?? now,
        updatedAt: now,
      })
      .where(eq(users.id, localUserId));
  }

  console.log('Local Roomote seed complete');
  process.exit(0);
}

seed().catch((error) => {
  console.error('Failed to seed database:', error);
  process.exit(1);
});
