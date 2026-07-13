import { Template, type LogEntry } from 'e2b';

/**
 * Default template name for the Roomote worker base template. The tag is
 * derived from the worker image tag so each template reference identifies
 * exactly one worker image build.
 */
export const E2B_WORKER_TEMPLATE_NAME = 'roomote-worker';

/**
 * E2B rejects template builds requesting more memory than the account plan
 * allows ("Memory can't be higher than 8192 MiB" on standard plans), so the
 * defaults stay inside the standard-plan ceiling.
 */
export const E2B_TEMPLATE_DEFAULT_CPU_COUNT = 8;
export const E2B_TEMPLATE_DEFAULT_MEMORY_MB = 8_192;

export interface BuildE2bWorkerTemplateOptions {
  apiKey: string;
  /** Custom E2B domain for self-hosted clusters. */
  domain?: string;
  /**
   * Registry-qualified worker image reference (e.g. `ghcr.io/...:tag`).
   * E2B pulls this from the registry in its cloud builder, so bare local
   * Docker tags are rejected up front.
   */
  imageRef: string;
  /** Overrides the derived `roomote-worker:<image-tag>` template reference. */
  templateRef?: string;
  cpuCount?: number;
  memoryMB?: number;
  /** Credentials for private registries (the GHCR worker image is private). */
  registryUsername?: string;
  registryPassword?: string;
  onBuildLog?: (logEntry: LogEntry) => void;
}

export interface BuiltE2bWorkerTemplate {
  /** Versioned template reference suitable for `E2B_TEMPLATE_ID`. */
  templateRef: string;
  templateId: string;
  buildId: string;
  tags: string[];
}

export function deriveE2bWorkerTemplateRef(imageRef: string): string {
  const imageTag = imageRef.includes(':')
    ? imageRef.slice(imageRef.lastIndexOf(':') + 1)
    : 'latest';

  return `${E2B_WORKER_TEMPLATE_NAME}:${imageTag}`;
}

/**
 * Builds the Roomote worker base template in the authenticated E2B account
 * from a published worker image.
 */
export async function buildE2bWorkerTemplate(
  options: BuildE2bWorkerTemplateOptions,
): Promise<BuiltE2bWorkerTemplate> {
  const {
    apiKey,
    domain,
    imageRef,
    registryUsername,
    registryPassword,
    onBuildLog,
  } = options;

  if (!imageRef.includes('/')) {
    throw new Error(
      `E2B template builds need a registry-qualified worker image; got "${imageRef}"`,
    );
  }

  const templateRef =
    options.templateRef ?? deriveE2bWorkerTemplateRef(imageRef);

  console.log(
    `[buildE2bWorkerTemplate] Starting ${JSON.stringify({
      imageRef,
      templateRef,
      domain: domain ?? '(default)',
      hasRegistryCredentials: !!(registryUsername && registryPassword),
    })}`,
  );

  const template = Template()
    .fromImage(
      imageRef,
      registryUsername && registryPassword
        ? { username: registryUsername, password: registryPassword }
        : undefined,
    )
    .runCmd('sudo docker compose version');

  const buildInfo = await Template.build(template, templateRef, {
    apiKey,
    ...(domain ? { domain } : {}),
    cpuCount: options.cpuCount ?? E2B_TEMPLATE_DEFAULT_CPU_COUNT,
    memoryMB: options.memoryMB ?? E2B_TEMPLATE_DEFAULT_MEMORY_MB,
    ...(onBuildLog ? { onBuildLogs: onBuildLog } : {}),
  });

  console.log(
    `[buildE2bWorkerTemplate] Build complete ${JSON.stringify({
      templateRef,
      templateId: buildInfo.templateId,
      buildId: buildInfo.buildId,
      tags: buildInfo.tags,
    })}`,
  );

  return {
    templateRef,
    templateId: buildInfo.templateId,
    buildId: buildInfo.buildId,
    tags: buildInfo.tags,
  };
}
