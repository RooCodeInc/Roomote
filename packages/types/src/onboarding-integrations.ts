import {
  communicationProviders,
  communicationProviderDisplayNames,
} from './communication';
import { MCP_INTEGRATIONS } from './mcp-oauth';
import { sourceControlProviders } from './source-control';
import { computeProviders } from './compute-providers/compute-provider';
import { SETUP_MODEL_PROVIDER_IDS } from './model-provider-config';
import type { AcpRequestUserInputAnswers } from './acp';

export const ADMIN_INTEGRATION_ORDER = [
  'notion',
  'sentry',
  'linear',
  'jira',
  'monday',
  'vercel',
  'supabase',
  'posthog',
  'grafana',
  'asana',
] as const;

// The homepage account-linking provider is named microsoft, while chat uses teams.
export const COMMUNICATION_PROVIDER_ORDER = [
  'slack',
  'microsoft',
  'telegram',
  'discord',
] as const;
export const SOURCE_CONTROL_PROVIDER_ORDER = [
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
] as const;

export const SETUP_INTEGRATION_EXCLUDED_PROVIDER_IDS: ReadonlySet<string> =
  new Set([
    ...sourceControlProviders,
    ...communicationProviders,
    ...computeProviders,
    // Vercel's deployments connector is distinct from Vercel AI Gateway inference.
    ...SETUP_MODEL_PROVIDER_IDS.filter((id) => id !== 'vercel'),
  ]);

export type SetupIntegrationId = (typeof MCP_INTEGRATIONS)[number]['id'];

export const SETUP_INTEGRATIONS = [
  ...new Set<string>([
    ...ADMIN_INTEGRATION_ORDER,
    ...MCP_INTEGRATIONS.map((integration) => integration.id),
  ]),
]
  .filter((id) => !SETUP_INTEGRATION_EXCLUDED_PROVIDER_IDS.has(id))
  .flatMap<{
    id: SetupIntegrationId;
    name: string;
    kind: 'mcp';
  }>((id) => {
    const integration = MCP_INTEGRATIONS.find(
      (candidate) => candidate.id === id,
    );
    return integration
      ? [{ id, name: integration.name, kind: 'mcp' as const }]
      : [];
  });

const setupIntegrationCategories = [
  {
    id: 'documents',
    label: 'Documents',
    question: 'Where do you keep team documents and knowledge?',
    integrationIds: ['notion', 'granola', 'supermemory'],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    question: 'What do you use for monitoring and product analytics?',
    integrationIds: [
      'sentry',
      'posthog',
      'grafana',
      'betterstack',
      'braintrust',
    ],
  },
  {
    id: 'project-tracking',
    label: 'Project tracking',
    question: 'Where do you track projects and issues?',
    integrationIds: ['linear', 'jira', 'monday', 'asana'],
  },
] as const;

export type SetupIntegrationCategoryId =
  (typeof setupIntegrationCategories)[number]['id'];

export function getSetupIntegrationCategories(
  homepageOrder: readonly string[] = ADMIN_INTEGRATION_ORDER,
) {
  const order = [
    ...new Set([
      ...homepageOrder,
      ...SETUP_INTEGRATIONS.map((integration) => integration.id),
    ]),
  ].filter((id) =>
    SETUP_INTEGRATIONS.some((integration) => integration.id === id),
  );
  return setupIntegrationCategories
    .map((category) => ({
      ...category,
      integrationIds: order.filter((id) =>
        (category.integrationIds as readonly string[]).includes(id),
      ),
    }))
    .filter((category) => category.integrationIds.length > 0)
    .sort(
      (left, right) =>
        order.indexOf(left.integrationIds[0]!) -
        order.indexOf(right.integrationIds[0]!),
    );
}

export const SETUP_INTEGRATION_CATEGORIES = getSetupIntegrationCategories();

export const SETUP_INTEGRATIONS_QUESTION_ID = 'setup-integrations';
export const SETUP_INTEGRATIONS_CONTINUE_OPTION = {
  id: 'continue',
  label: 'Continue',
  description:
    'Continue with or without connecting tools. You can connect them later in Settings.',
} as const;

export function getSetupIntegrationQuestionId(
  categoryId: SetupIntegrationCategoryId,
): string {
  return `setup-tools-${categoryId}`;
}

/** Older sessions can still have an unanswered communication discovery question. */
export function isSetupIntegrationDiscoveryQuestionId(
  questionId: string,
): boolean {
  return (
    questionId === 'setup-tools-communication' ||
    SETUP_INTEGRATION_CATEGORIES.some(
      (category) => getSetupIntegrationQuestionId(category.id) === questionId,
    )
  );
}

/** Only whole catalog IDs/names match; unsupported tools never become a guessed connector. */
export function matchSetupIntegrationAnswers(
  answers: AcpRequestUserInputAnswers,
) {
  const matched = new Set<SetupIntegrationId>();
  const unsupported = new Set<string>();
  const answeredCategoryIds: SetupIntegrationCategoryId[] = [];
  for (const category of SETUP_INTEGRATION_CATEGORIES) {
    const response =
      answers[getSetupIntegrationQuestionId(category.id)] ??
      answers[category.id];
    if (!response) continue;
    answeredCategoryIds.push(category.id);
    for (const value of response.answers.flatMap((answer) =>
      answer.split(/[,;\n]/),
    )) {
      const token = value.trim().toLowerCase();
      if (
        !token ||
        ['none', 'skip', 'skip for now', 'not sure'].includes(token)
      )
        continue;
      const integration = SETUP_INTEGRATIONS.find(
        (candidate) =>
          candidate.id.toLowerCase() === token ||
          candidate.name.toLowerCase() === token,
      );
      if (integration) matched.add(integration.id);
      else if (
        !SETUP_INTEGRATION_EXCLUDED_PROVIDER_IDS.has(token) &&
        !Object.values(communicationProviderDisplayNames).some(
          (name) => name.toLowerCase() === token,
        ) &&
        !MCP_INTEGRATIONS.some(
          (candidate) =>
            candidate.id.toLowerCase() === token ||
            candidate.name.toLowerCase() === token,
        )
      )
        unsupported.add(value.trim());
    }
  }
  return {
    answeredCategoryIds,
    matchedIntegrationIds: SETUP_INTEGRATIONS.filter((integration) =>
      matched.has(integration.id),
    ).map((integration) => integration.id),
    unsupportedTools: [...unsupported],
  };
}
