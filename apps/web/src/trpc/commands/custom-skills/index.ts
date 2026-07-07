import { createHash } from 'node:crypto';
import {
  and,
  asc,
  db,
  environments,
  eq,
  isNull,
  updateEnvironmentDefinition,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  environmentManualSkillSchema,
  environmentConfigSchema,
  type EnvironmentConfig,
  type EnvironmentManualSkill,
  renderManualSkillMarkdown,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const DEFAULT_SEARCH_RESULT_LIMIT = 20;
const ALL_SKILLS_SENTINEL = '*';
const MANUAL_SKILL_SOURCE = 'manual';
const MANUAL_SKILL_ID_PREFIX = `${MANUAL_SKILL_SOURCE}@`;
const MANUAL_SKILL_VARIANT_SEPARATOR = '#';
const MANUAL_SKILL_VARIANT_KEY_LENGTH = 12;
const MARKETPLACE_BASE_URL = process.env.SKILLS_API_URL || 'https://skills.sh';
const MARKETPLACE_SEARCH_ERROR_MESSAGE =
  "Couldn't search the marketplace right now, please try again later.";

const SKILL_SOURCE_REGEX = /^[^/\s]+\/[^/\s]+$/;
const SKILL_NAME_REGEX = /^[^/\s]+$/;
const MANUAL_SKILL_VARIANT_KEY_REGEX = new RegExp(
  `^[a-f0-9]{${MANUAL_SKILL_VARIANT_KEY_LENGTH}}$`,
);

type EnvironmentSummary = {
  id: string;
  name: string;
};

type MarketplaceSkillSelection = {
  kind: 'marketplace';
  source: string;
  name: string;
  isAllSelection: boolean;
};

type ManualSkillSelection = {
  kind: 'manual';
  source: typeof MANUAL_SKILL_SOURCE;
  name: string;
  variantKey: string;
  isAllSelection: false;
};

type SkillSelection = MarketplaceSkillSelection | ManualSkillSelection;

type CustomSkillRecord = {
  kind: SkillSelection['kind'];
  source: string;
  name: string;
  skillId: string;
  isAllSelection: boolean;
  installsLabel: string | null;
  url: string | null;
  description: string | null;
  content: string | null;
};

type InstalledCustomSkillRecord = CustomSkillRecord & {
  environments: EnvironmentSummary[];
};

type DerivedInstalledSkillsResult = {
  environments: EnvironmentSummary[];
  installed: InstalledCustomSkillRecord[];
};

type ListCustomSkillsResult = DerivedInstalledSkillsResult & {
  deploymentName: string;
};

type MarketplaceSkillApiRecord = {
  id?: unknown;
  skillId?: unknown;
  name?: unknown;
  source?: unknown;
  installs?: unknown;
};

type SkillsMarketplaceApiResponse = {
  skills?: MarketplaceSkillApiRecord[];
};

function assertCustomSkillsAccess(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

function formatInstallCountLabel(installs: number | null | undefined) {
  if (!installs || installs <= 0) {
    return null;
  }

  if (installs >= 1_000_000) {
    return `${(installs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`;
  }

  if (installs >= 1_000) {
    return `${(installs / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`;
  }

  return `${installs} install${installs === 1 ? '' : 's'}`;
}

function buildMarketplaceUrl(skillSlug: string): string | null {
  try {
    return new URL(skillSlug, `${MARKETPLACE_BASE_URL}/`).toString();
  } catch {
    return null;
  }
}

type ManualSkillDefinition = EnvironmentManualSkill;

function createManualSkillVariantKey(
  manualSkill: ManualSkillDefinition,
): string {
  return createHash('sha256')
    .update(renderManualSkillMarkdown(manualSkill))
    .digest('hex')
    .slice(0, MANUAL_SKILL_VARIANT_KEY_LENGTH);
}

function buildManualSkillSelection(
  manualSkill: ManualSkillDefinition,
): ManualSkillSelection {
  return {
    kind: 'manual',
    source: MANUAL_SKILL_SOURCE,
    name: manualSkill.name,
    variantKey: createManualSkillVariantKey(manualSkill),
    isAllSelection: false,
  };
}

function matchesManualSkillVariant(
  selection: ManualSkillSelection,
  manualSkill: ManualSkillDefinition | undefined,
): boolean {
  return (
    !!manualSkill &&
    createManualSkillVariantKey(manualSkill) === selection.variantKey
  );
}

function createSkillId(selection: SkillSelection): string {
  if (selection.kind === 'manual') {
    return `${MANUAL_SKILL_ID_PREFIX}${selection.name}${MANUAL_SKILL_VARIANT_SEPARATOR}${selection.variantKey}`;
  }

  return `${selection.source}@${selection.isAllSelection ? ALL_SKILLS_SENTINEL : selection.name}`;
}

function parseSkillId(skillId: string): SkillSelection {
  if (skillId.startsWith(MANUAL_SKILL_ID_PREFIX)) {
    const manualSkillPayload = skillId.slice(MANUAL_SKILL_ID_PREFIX.length);
    const variantSeparatorIndex = manualSkillPayload.lastIndexOf(
      MANUAL_SKILL_VARIANT_SEPARATOR,
    );

    if (
      variantSeparatorIndex <= 0 ||
      variantSeparatorIndex === manualSkillPayload.length - 1
    ) {
      throw new Error('Invalid manual skill identifier.');
    }

    const manualSkillName = manualSkillPayload.slice(0, variantSeparatorIndex);
    const variantKey = manualSkillPayload.slice(variantSeparatorIndex + 1);

    if (!SKILL_NAME_REGEX.test(manualSkillName)) {
      throw new Error('Invalid manual skill name.');
    }

    if (!MANUAL_SKILL_VARIANT_KEY_REGEX.test(variantKey)) {
      throw new Error('Invalid manual skill identifier.');
    }

    return {
      kind: 'manual',
      source: MANUAL_SKILL_SOURCE,
      name: manualSkillName,
      variantKey,
      isAllSelection: false,
    };
  }

  const splitIndex = skillId.indexOf('@');

  if (splitIndex <= 0 || splitIndex === skillId.length - 1) {
    throw new Error('Invalid skill identifier.');
  }

  const source = skillId.slice(0, splitIndex);
  const nameOrSentinel = skillId.slice(splitIndex + 1);

  if (!SKILL_SOURCE_REGEX.test(source)) {
    throw new Error('Invalid skill source.');
  }

  if (nameOrSentinel === ALL_SKILLS_SENTINEL) {
    return {
      kind: 'marketplace',
      source,
      name: ALL_SKILLS_SENTINEL,
      isAllSelection: true,
    };
  }

  if (!SKILL_NAME_REGEX.test(nameOrSentinel)) {
    throw new Error('Invalid skill name.');
  }

  return {
    kind: 'marketplace',
    source,
    name: nameOrSentinel,
    isAllSelection: false,
  };
}

function parseSkillsMarketplaceApiResponse(
  response: SkillsMarketplaceApiResponse,
  limit = DEFAULT_SEARCH_RESULT_LIMIT,
): CustomSkillRecord[] {
  if (!Array.isArray(response.skills)) {
    throw new Error(MARKETPLACE_SEARCH_ERROR_MESSAGE);
  }

  const bySkillId = new Map<string, CustomSkillRecord>();

  for (const rawSkill of response.skills) {
    const source =
      typeof rawSkill.source === 'string' ? rawSkill.source.trim() : '';
    const canonicalSkillName =
      typeof rawSkill.skillId === 'string' ? rawSkill.skillId.trim() : '';
    const displayName =
      typeof rawSkill.name === 'string' ? rawSkill.name.trim() : '';

    if (
      !source ||
      !canonicalSkillName ||
      !displayName ||
      !SKILL_SOURCE_REGEX.test(source)
    ) {
      continue;
    }

    if (!SKILL_NAME_REGEX.test(canonicalSkillName)) {
      continue;
    }

    const selection: SkillSelection = {
      kind: 'marketplace',
      source,
      name: canonicalSkillName,
      isAllSelection: false,
    };
    const skillId = createSkillId(selection);

    if (bySkillId.has(skillId)) {
      continue;
    }

    bySkillId.set(skillId, {
      kind: 'marketplace',
      source,
      name: displayName,
      skillId,
      isAllSelection: false,
      installsLabel: formatInstallCountLabel(
        typeof rawSkill.installs === 'number' ? rawSkill.installs : null,
      ),
      url:
        typeof rawSkill.id === 'string'
          ? buildMarketplaceUrl(rawSkill.id)
          : null,
      description: null,
      content: null,
    });
  }

  return Array.from(bySkillId.values()).slice(0, limit);
}

async function runSkillsMarketplaceSearch(
  query: string,
): Promise<CustomSkillRecord[]> {
  try {
    const url = new URL('/api/search', MARKETPLACE_BASE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(DEFAULT_SEARCH_RESULT_LIMIT));

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(MARKETPLACE_SEARCH_ERROR_MESSAGE);
    }

    const payload = (await response.json()) as SkillsMarketplaceApiResponse;
    return parseSkillsMarketplaceApiResponse(
      payload,
      DEFAULT_SEARCH_RESULT_LIMIT,
    );
  } catch {
    throw new Error(MARKETPLACE_SEARCH_ERROR_MESSAGE);
  }
}

async function listOrganizationEnvironments(
  auth: UserAuthSuccess,
  tx: DatabaseOrTransaction = db,
) {
  return tx
    .select({
      id: environments.id,
      name: environments.name,
      config: environments.config,
    })
    .from(environments)
    .where(and(isNull(environments.userId), eq(environments.isEval, false)))
    .orderBy(asc(environments.name));
}

type InstalledAccumulator = {
  kind: SkillSelection['kind'];
  source: string;
  name: string;
  skillId: string;
  isAllSelection: boolean;
  installsLabel: string | null;
  url: string | null;
  description: string | null;
  content: string | null;
  environmentMap: Map<string, EnvironmentSummary>;
};

function getEnvironmentSummary(environment: {
  id: string;
  name: string;
}): EnvironmentSummary {
  return {
    id: environment.id,
    name: environment.name,
  };
}

function addEnvironmentToInstalledAccumulator(
  accumulator: InstalledAccumulator,
  environment: { id: string; name: string },
) {
  accumulator.environmentMap.set(
    environment.id,
    getEnvironmentSummary(environment),
  );
}

function getOrCreateInstalledAccumulator(
  installed: Map<string, InstalledAccumulator>,
  selection: SkillSelection,
): InstalledAccumulator {
  const skillId = createSkillId(selection);
  const existing = installed.get(skillId);

  if (existing) {
    return existing;
  }

  const created: InstalledAccumulator = {
    kind: selection.kind,
    source: selection.source,
    name: selection.name,
    skillId,
    isAllSelection: selection.isAllSelection,
    installsLabel: null,
    url: null,
    description: null,
    content: null,
    environmentMap: new Map(),
  };
  installed.set(skillId, created);

  return created;
}

function deriveInstalledSkills(
  input: Array<{ id: string; name: string; config: EnvironmentConfig }>,
): DerivedInstalledSkillsResult {
  const environmentsList = input.map((environment) => ({
    id: environment.id,
    name: environment.name,
  }));
  const installed = new Map<string, InstalledAccumulator>();

  for (const environment of input) {
    const configSkills = environment.config.skills;
    const manualSkills = environment.config.manualSkills;

    if (configSkills) {
      for (const [source, selection] of Object.entries(configSkills)) {
        if (selection === 'all') {
          const allSelection: SkillSelection = {
            kind: 'marketplace',
            source,
            name: ALL_SKILLS_SENTINEL,
            isAllSelection: true,
          };
          const accumulator = getOrCreateInstalledAccumulator(
            installed,
            allSelection,
          );
          addEnvironmentToInstalledAccumulator(accumulator, environment);

          continue;
        }

        for (const name of selection) {
          const specificSelection: SkillSelection = {
            kind: 'marketplace',
            source,
            name,
            isAllSelection: false,
          };
          const accumulator = getOrCreateInstalledAccumulator(
            installed,
            specificSelection,
          );
          addEnvironmentToInstalledAccumulator(accumulator, environment);
        }
      }
    }

    if (manualSkills) {
      for (const manualSkill of manualSkills) {
        const selection = buildManualSkillSelection(manualSkill);
        const accumulator = getOrCreateInstalledAccumulator(
          installed,
          selection,
        );

        accumulator.description ??= manualSkill.description;
        accumulator.content ??= manualSkill.content;
        addEnvironmentToInstalledAccumulator(accumulator, environment);
      }
    }
  }

  return {
    environments: environmentsList,
    installed: Array.from(installed.values())
      .map((entry) => ({
        kind: entry.kind,
        source: entry.source,
        name: entry.name,
        skillId: entry.skillId,
        isAllSelection: entry.isAllSelection,
        installsLabel: entry.installsLabel,
        url: entry.url,
        description: entry.description,
        content: entry.content,
        environments: Array.from(entry.environmentMap.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === 'manual' ? -1 : 1;
        }

        if (left.source !== right.source) {
          return left.source.localeCompare(right.source);
        }

        if (left.isAllSelection !== right.isAllSelection) {
          return left.isAllSelection ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      }),
  };
}

export async function listCustomSkillsCommand(
  auth: UserAuthSuccess,
): Promise<ListCustomSkillsResult> {
  assertCustomSkillsAccess(auth);

  const orgEnvironments = await listOrganizationEnvironments(auth);
  const parsed = orgEnvironments.map((environment) => {
    const parseResult = environmentConfigSchema.safeParse(environment.config);

    if (!parseResult.success) {
      throw new Error(
        `Invalid configuration on environment "${environment.name}".`,
      );
    }

    return {
      ...environment,
      config: parseResult.data,
    };
  });

  return {
    ...deriveInstalledSkills(parsed),
    deploymentName: 'this deployment',
  };
}

export async function searchCustomSkillsCommand(
  auth: UserAuthSuccess,
  input: { query: string },
): Promise<CustomSkillRecord[]> {
  assertCustomSkillsAccess(auth);

  const query = input.query.trim();

  if (query.length < 2) {
    return [];
  }

  return runSkillsMarketplaceSearch(query);
}

function normalizeEnvironmentIdSelection(environmentIds: string[]): string[] {
  return [...new Set(environmentIds)].sort((a, b) => a.localeCompare(b));
}

function sortManualSkills(
  manualSkills: ManualSkillDefinition[],
): ManualSkillDefinition[] {
  return [...manualSkills].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function validateSelectedEnvironmentIds(
  orgEnvironments: Array<{ id: string }>,
  selectedEnvironmentIds: string[],
) {
  const orgEnvironmentIds = new Set(orgEnvironments.map((env) => env.id));

  for (const environmentId of selectedEnvironmentIds) {
    if (!orgEnvironmentIds.has(environmentId)) {
      throw new Error('Selected environments must belong to this deployment.');
    }
  }
}

export async function setCustomSkillAvailabilityCommand(
  auth: UserAuthSuccess,
  input: { skillId: string; environmentIds: string[] },
): Promise<{ success: true; updatedEnvironmentIds: string[] }> {
  assertCustomSkillsAccess(auth);

  const selection = parseSkillId(input.skillId);
  if (selection.kind === 'manual') {
    throw new Error('Use saveManual or remove to manage manual skills.');
  }

  const selectedEnvironmentIds = normalizeEnvironmentIdSelection(
    input.environmentIds,
  );

  if (selectedEnvironmentIds.length === 0) {
    throw new Error('Select at least one environment.');
  }

  const orgEnvironments = await listOrganizationEnvironments(auth);
  validateSelectedEnvironmentIds(orgEnvironments, selectedEnvironmentIds);

  return db.transaction(async (tx) => {
    const now = new Date();
    const updatedEnvironmentIds = new Set<string>();

    for (const environment of orgEnvironments) {
      const parseResult = environmentConfigSchema.safeParse(
        environment.config as EnvironmentConfig,
      );

      if (!parseResult.success) {
        throw new Error(
          `Invalid configuration on environment "${environment.name}".`,
        );
      }

      const currentConfig = parseResult.data;
      const selected = selectedEnvironmentIds.includes(environment.id);
      const previousManualSkills = currentConfig.manualSkills ?? [];
      const currentManualSkills = [...previousManualSkills];
      const currentSkills = { ...(currentConfig.skills ?? {}) };
      const previousSkills = currentConfig.skills ?? {};

      if (selection.isAllSelection) {
        if (selected) {
          currentSkills[selection.source] = 'all';
        } else if (currentSkills[selection.source] === 'all') {
          delete currentSkills[selection.source];
        }
      } else {
        const existing = currentSkills[selection.source];

        if (selected) {
          if (existing !== 'all') {
            const nextSelection = new Set(existing ?? []);
            nextSelection.add(selection.name);
            currentSkills[selection.source] = Array.from(nextSelection).sort(
              (left, right) => left.localeCompare(right),
            );
          }
        } else if (existing && existing !== 'all') {
          const nextSelection = existing.filter(
            (name) => name !== selection.name,
          );

          if (nextSelection.length === 0) {
            delete currentSkills[selection.source];
          } else {
            currentSkills[selection.source] = nextSelection;
          }
        }
      }

      const nextConfig: EnvironmentConfig = { ...currentConfig };
      if (Object.keys(currentSkills).length > 0) {
        nextConfig.skills = currentSkills;
      } else {
        delete nextConfig.skills;
      }
      if (currentManualSkills.length > 0) {
        nextConfig.manualSkills = sortManualSkills(currentManualSkills);
      } else {
        delete nextConfig.manualSkills;
      }

      const nextConfigParseResult =
        environmentConfigSchema.safeParse(nextConfig);

      if (!nextConfigParseResult.success) {
        throw new Error(
          `Invalid configuration generated for environment "${environment.name}".`,
        );
      }

      if (
        JSON.stringify(previousSkills) ===
          JSON.stringify(nextConfigParseResult.data.skills ?? {}) &&
        JSON.stringify(previousManualSkills) ===
          JSON.stringify(nextConfigParseResult.data.manualSkills ?? [])
      ) {
        continue;
      }

      await updateEnvironmentDefinition(tx, {
        environmentId: environment.id,
        fields: {
          config: nextConfigParseResult.data,
        },
        updatedAt: now,
      });

      updatedEnvironmentIds.add(environment.id);
    }

    return {
      success: true as const,
      updatedEnvironmentIds: Array.from(updatedEnvironmentIds),
    };
  });
}

export async function saveManualSkillCommand(
  auth: UserAuthSuccess,
  input: {
    name: string;
    description: string;
    content: string;
    environmentIds: string[];
    previousSkillId?: string;
  },
): Promise<{
  success: true;
  skillId: string;
  updatedEnvironmentIds: string[];
}> {
  assertCustomSkillsAccess(auth);

  const manualSkill = environmentManualSkillSchema.parse({
    name: input.name,
    description: input.description,
    content: input.content,
  });
  const selectedEnvironmentIds = normalizeEnvironmentIdSelection(
    input.environmentIds,
  );
  const previousSelection = input.previousSkillId
    ? parseSkillId(input.previousSkillId)
    : null;
  const previousManualSelection =
    previousSelection?.kind === 'manual' ? previousSelection : null;

  if (selectedEnvironmentIds.length === 0) {
    throw new Error('Select at least one environment.');
  }

  if (previousSelection && previousSelection.kind !== 'manual') {
    throw new Error('Manual skill updates require a manual skill identifier.');
  }

  const orgEnvironments = await listOrganizationEnvironments(auth);
  validateSelectedEnvironmentIds(orgEnvironments, selectedEnvironmentIds);

  return db.transaction(async (tx) => {
    const now = new Date();
    const updatedEnvironmentIds = new Set<string>();

    for (const environment of orgEnvironments) {
      const parseResult = environmentConfigSchema.safeParse(
        environment.config as EnvironmentConfig,
      );

      if (!parseResult.success) {
        throw new Error(
          `Invalid configuration on environment "${environment.name}".`,
        );
      }

      const currentConfig = parseResult.data;
      const previousManualSkills = currentConfig.manualSkills ?? [];
      const currentManualSkills = [...previousManualSkills];
      const selected = selectedEnvironmentIds.includes(environment.id);
      const currentVariant = previousManualSelection
        ? previousManualSkills.find((candidate) =>
            matchesManualSkillVariant(previousManualSelection, candidate),
          )
        : undefined;
      const hadPreviousVariant = previousManualSelection
        ? matchesManualSkillVariant(previousManualSelection, currentVariant)
        : false;

      const nextManualSkills = currentManualSkills.filter(
        (candidate) =>
          !(
            previousManualSelection &&
            matchesManualSkillVariant(previousManualSelection, candidate)
          ),
      );

      if (selected) {
        const existingByName = nextManualSkills.find(
          (candidate) => candidate.name === manualSkill.name,
        );

        if (existingByName) {
          throw new Error(
            `Environment "${environment.name}" already has a manual skill named "${manualSkill.name}".`,
          );
        }

        nextManualSkills.push(manualSkill);
      } else if (!hadPreviousVariant) {
        continue;
      }

      const nextConfig: EnvironmentConfig = { ...currentConfig };
      if (nextManualSkills.length > 0) {
        nextConfig.manualSkills = sortManualSkills(nextManualSkills);
      } else {
        delete nextConfig.manualSkills;
      }

      const nextConfigParseResult =
        environmentConfigSchema.safeParse(nextConfig);

      if (!nextConfigParseResult.success) {
        throw new Error(
          `Invalid configuration generated for environment "${environment.name}".`,
        );
      }

      if (
        JSON.stringify(previousManualSkills) ===
        JSON.stringify(nextConfigParseResult.data.manualSkills ?? [])
      ) {
        continue;
      }

      await updateEnvironmentDefinition(tx, {
        environmentId: environment.id,
        fields: {
          config: nextConfigParseResult.data,
        },
        updatedAt: now,
      });

      updatedEnvironmentIds.add(environment.id);
    }

    return {
      success: true as const,
      skillId: createSkillId(buildManualSkillSelection(manualSkill)),
      updatedEnvironmentIds: Array.from(updatedEnvironmentIds),
    };
  });
}

export async function removeCustomSkillCommand(
  auth: UserAuthSuccess,
  input: { skillId: string },
): Promise<{ success: true; updatedEnvironmentIds: string[] }> {
  assertCustomSkillsAccess(auth);

  const selection = parseSkillId(input.skillId);
  const orgEnvironments = await listOrganizationEnvironments(auth);

  return db.transaction(async (tx) => {
    const now = new Date();
    const updatedEnvironmentIds = new Set<string>();

    for (const environment of orgEnvironments) {
      const parseResult = environmentConfigSchema.safeParse(
        environment.config as EnvironmentConfig,
      );

      if (!parseResult.success) {
        throw new Error(
          `Invalid configuration on environment "${environment.name}".`,
        );
      }

      const currentConfig = parseResult.data;
      const previousManualSkills = currentConfig.manualSkills ?? [];
      const currentManualSkills = [...previousManualSkills];
      const previousSkills = currentConfig.skills ?? {};
      const currentSkills = { ...(currentConfig.skills ?? {}) };
      if (selection.kind === 'manual') {
        const nextManualSkills = currentManualSkills.filter(
          (candidate) => !matchesManualSkillVariant(selection, candidate),
        );

        if (nextManualSkills.length === currentManualSkills.length) {
          continue;
        }

        const nextConfig: EnvironmentConfig = { ...currentConfig };

        if (nextManualSkills.length > 0) {
          nextConfig.manualSkills = sortManualSkills(nextManualSkills);
        } else {
          delete nextConfig.manualSkills;
        }

        const nextConfigParseResult =
          environmentConfigSchema.safeParse(nextConfig);

        if (!nextConfigParseResult.success) {
          throw new Error(
            `Invalid configuration generated for environment "${environment.name}".`,
          );
        }

        if (
          JSON.stringify(previousManualSkills) ===
          JSON.stringify(nextConfigParseResult.data.manualSkills ?? [])
        ) {
          continue;
        }

        await updateEnvironmentDefinition(tx, {
          environmentId: environment.id,
          fields: {
            config: nextConfigParseResult.data,
          },
          updatedAt: now,
        });

        updatedEnvironmentIds.add(environment.id);
        continue;
      } else {
        const existing = currentSkills[selection.source];

        if (!existing) {
          continue;
        }

        if (selection.isAllSelection) {
          if (existing === 'all') {
            delete currentSkills[selection.source];
          } else {
            continue;
          }
        } else if (existing === 'all') {
          continue;
        } else {
          const nextSelection = existing.filter(
            (name) => name !== selection.name,
          );

          if (nextSelection.length === 0) {
            delete currentSkills[selection.source];
          } else {
            currentSkills[selection.source] = nextSelection;
          }
        }
      }

      const nextConfig: EnvironmentConfig = { ...currentConfig };
      if (Object.keys(currentSkills).length > 0) {
        nextConfig.skills = currentSkills;
      } else {
        delete nextConfig.skills;
      }
      if (currentManualSkills.length > 0) {
        nextConfig.manualSkills = sortManualSkills(currentManualSkills);
      } else {
        delete nextConfig.manualSkills;
      }

      const nextConfigParseResult =
        environmentConfigSchema.safeParse(nextConfig);

      if (!nextConfigParseResult.success) {
        throw new Error(
          `Invalid configuration generated for environment "${environment.name}".`,
        );
      }

      if (
        JSON.stringify(previousSkills) ===
          JSON.stringify(nextConfigParseResult.data.skills ?? {}) &&
        JSON.stringify(previousManualSkills) ===
          JSON.stringify(nextConfigParseResult.data.manualSkills ?? [])
      ) {
        continue;
      }

      await updateEnvironmentDefinition(tx, {
        environmentId: environment.id,
        fields: {
          config: nextConfigParseResult.data,
        },
        updatedAt: now,
      });

      updatedEnvironmentIds.add(environment.id);
    }

    return {
      success: true as const,
      updatedEnvironmentIds: Array.from(updatedEnvironmentIds),
    };
  });
}
