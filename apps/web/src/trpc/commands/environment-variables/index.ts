import {
  db,
  environmentVariables,
  eq,
  desc,
  inArray,
  not,
  getTableColumns,
  stringifyDecryptedEnvVarValue,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { decryptSecrets } from '@roomote/db/encryption';
import {
  COMMS_PROVIDER_ENV_VAR_NAMES,
  COMPUTE_PROVIDER_ENV_VAR_NAMES,
  CONTROL_PLANE_ENV_VAR_NAMES,
  isAutoProvisionedComputeArtifactField,
  ROOMOTE_MANAGED_ENV_VAR_NAMES,
  SOURCE_CONTROL_SECRET_ENV_VAR_NAMES,
  normalizePemEnvValue,
} from '@roomote/types';

import {
  createEnvVarSchema,
  updateEnvVarSchema,
} from '@/types/environment-variables';

import type { UserAuthSuccess } from '@/types';

export function assertAdmin(auth: Pick<UserAuthSuccess, 'isAdmin'>) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

export async function getPersistedEnvironmentVariableNames(
  executor: DatabaseOrTransaction = db,
): Promise<string[]> {
  const envVarRows = await executor
    .select({ name: environmentVariables.name })
    .from(environmentVariables);

  return envVarRows.map((envVar) => envVar.name);
}

export async function getPersistedEnvironmentVariableValues(
  names: string[],
  executor: DatabaseOrTransaction = db,
): Promise<Record<string, string>> {
  if (names.length === 0) {
    return {};
  }

  const envVarRows = await executor
    .select({
      name: environmentVariables.name,
      value: environmentVariables.value,
    })
    .from(environmentVariables)
    .where(inArray(environmentVariables.name, names));

  const values: Record<string, string> = {};

  for (const envVar of envVarRows) {
    const decryptedValue = await decryptSecrets<string>(envVar.value);
    const value = stringifyDecryptedEnvVarValue(decryptedValue).trim();

    if (value) {
      values[envVar.name] = value;
    }
  }

  return values;
}

// Control-plane / provider / instance names are hidden from the generic
// editor and reserved on create. Shares the canonical set with the job
// env-injection denylist so the two cannot drift apart.
const PROVIDER_MANAGED_ENV_VAR_NAME_LIST = [
  ...CONTROL_PLANE_ENV_VAR_NAMES,
  ...ROOMOTE_MANAGED_ENV_VAR_NAMES,
];

export async function upsertDeploymentEnvironmentVariables(
  tx: DatabaseOrTransaction,
  {
    userId,
    values,
  }: {
    userId: string | null;
    values: Array<{ name: string; value: string }>;
  },
) {
  if (values.length === 0) {
    return;
  }

  const names = Array.from(new Set(values.map((value) => value.name)));

  const existingEnvVars = await tx
    .select({
      id: environmentVariables.id,
      name: environmentVariables.name,
    })
    .from(environmentVariables)
    .where(inArray(environmentVariables.name, names));

  const existingByName = new Map(
    existingEnvVars.map((envVar) => [envVar.name, envVar.id]),
  );

  const now = new Date();
  const valuesToInsert: Array<{
    userId: null;
    name: string;
    value: string;
    createdByUserId: string | null;
    lastUpdatedByUserId: string | null;
  }> = [];

  for (const value of values) {
    const existingId = existingByName.get(value.name);
    const normalizedValue = normalizePemEnvValue(value.value);

    if (!existingId) {
      valuesToInsert.push({
        userId: null,
        name: value.name,
        value: normalizedValue,
        createdByUserId: userId,
        lastUpdatedByUserId: userId,
      });
      continue;
    }

    await tx
      .update(environmentVariables)
      .set({
        value: normalizedValue,
        lastUpdatedByUserId: userId,
        updatedAt: now,
      })
      .where(eq(environmentVariables.id, existingId));
  }

  if (valuesToInsert.length > 0) {
    await tx.insert(environmentVariables).values(valuesToInsert);
  }
}

export async function deleteDeploymentEnvironmentVariables(
  tx: DatabaseOrTransaction,
  names: string[],
) {
  if (names.length === 0) {
    return;
  }

  await tx
    .delete(environmentVariables)
    .where(inArray(environmentVariables.name, [...new Set(names)]));
}

export async function getEnvVarsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const { value: _value, ...columns } = getTableColumns(environmentVariables);

  return db
    .select(columns)
    .from(environmentVariables)
    .where(
      not(
        inArray(environmentVariables.name, PROVIDER_MANAGED_ENV_VAR_NAME_LIST),
      ),
    )
    .orderBy(desc(environmentVariables.updatedAt));
}

export async function deleteEnvVarCommand(
  auth: UserAuthSuccess,
  input: { id: string },
) {
  assertAdmin(auth);

  const [envVar] = await db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.id, input.id))
    .limit(1);

  if (!envVar) {
    return { success: false as const, error: 'Environment variable not found' };
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(environmentVariables)
      .where(eq(environmentVariables.id, envVar.id));
  });

  return { success: true as const };
}

export async function createEnvVarCommand(
  auth: UserAuthSuccess,
  input: { name: string; value: string },
) {
  const { userId } = auth;
  assertAdmin(auth);

  const { name, value } = createEnvVarSchema.parse(input);

  if (COMMS_PROVIDER_ENV_VAR_NAMES.has(name)) {
    throw new Error(
      `"${name}" is a reserved communications provider variable. Configure it under Settings → Communications.`,
    );
  }

  if (COMPUTE_PROVIDER_ENV_VAR_NAMES.has(name)) {
    if (isAutoProvisionedComputeArtifactField({ envVarName: name })) {
      throw new Error(
        `"${name}" is a reserved sandbox provider variable. Set it in the deployment environment, or let Roomote provision it automatically after saving provider credentials under Settings → Sandboxes.`,
      );
    }

    throw new Error(
      `"${name}" is a reserved sandbox provider variable. Configure it under Settings → Sandboxes.`,
    );
  }

  if (SOURCE_CONTROL_SECRET_ENV_VAR_NAMES.has(name)) {
    throw new Error(
      `"${name}" is a reserved source-control provider variable. Configure it under Settings → Source Control.`,
    );
  }

  if (CONTROL_PLANE_ENV_VAR_NAMES.has(name)) {
    throw new Error(
      `"${name}" is a reserved deployment variable and cannot be set here.`,
    );
  }

  if (ROOMOTE_MANAGED_ENV_VAR_NAMES.has(name)) {
    throw new Error(`"${name}" is managed by Roomote and cannot be set here.`);
  }

  const [existing] = await db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.name, name))
    .limit(1);

  if (existing) {
    throw new Error('Environment variable already exists');
  }

  const [created] = await db
    .insert(environmentVariables)
    .values({
      userId: null,
      name,
      value: normalizePemEnvValue(value),
      createdByUserId: userId,
      lastUpdatedByUserId: userId,
    })
    .returning();

  if (!created) {
    throw new Error('Failed to create environment variable');
  }
}

export async function updateEnvVarCommand(
  auth: UserAuthSuccess,
  input: { id: string; value: string },
) {
  const { userId } = auth;
  assertAdmin(auth);

  const { value } = updateEnvVarSchema.parse(input);

  const [envVar] = await db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.id, input.id))
    .limit(1);

  if (!envVar) {
    throw new Error('Environment variable not found');
  }

  const [updatedEnvVar] = await db
    .update(environmentVariables)
    .set({
      value: normalizePemEnvValue(value),
      lastUpdatedByUserId: userId,
      updatedAt: new Date(),
    })
    .where(eq(environmentVariables.id, envVar.id))
    .returning();

  if (!updatedEnvVar) {
    throw new Error('Failed to update environment variable');
  }
}
