import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { GitHubInstallation, CreateGitHubInstallation } from '../../types';
import { githubInstallations } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';

export const githubInstallationFactory = Factory.define<
  CreateGitHubInstallation,
  { db?: DatabaseOrTransaction },
  GitHubInstallation
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const [inserted] = await (transientParams.db || db)
      .insert(githubInstallations)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert GitHub installation');
    }

    return inserted;
  });

  const { installedByUserId, installationId, ...rest } = params;

  return {
    installedByUserId: installedByUserId || faker.string.uuid(),
    installationId: installationId || faker.number.int(),
    appId: faker.number.int(),
    accountLogin: faker.internet.username(),
    accountType: 'Organization',
    permissions: {},
    ...rest,
  } satisfies CreateGitHubInstallation;
});
