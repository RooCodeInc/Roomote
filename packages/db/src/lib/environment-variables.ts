import { type DatabaseOrTransaction, db } from '../db';
import { decryptSecrets } from '../encryption';

export function stringifyDecryptedEnvVarValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const jsonValue = JSON.stringify(value);
  return jsonValue ?? String(value);
}

export async function resolveDeploymentEnvVar(
  name: string,
  executor: DatabaseOrTransaction = db,
): Promise<string | null> {
  const processValue = process.env[name]?.trim();

  if (processValue) {
    return processValue;
  }

  const encryptedEnvVars = await executor.query.environmentVariables.findMany({
    where: (environmentVariables, { eq }) =>
      eq(environmentVariables.name, name),
  });

  for (const envVar of encryptedEnvVars) {
    const decryptedValue = await decryptSecrets<string>(envVar.value);

    if (!decryptedValue) {
      return null;
    }

    const value = stringifyDecryptedEnvVarValue(decryptedValue).trim();
    return value || null;
  }

  return null;
}
