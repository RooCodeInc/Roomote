export {
  appendEnvironmentDefinitionGuidance,
  normalizeRepositorySelection,
  buildEnvironmentDefinitionWorkspacePayload as buildSetupNewWorkspacePayload,
  buildCreateEnvironmentDefinitionPrompt as buildSetupNewKickoffPrompt,
} from '@roomote/types';

export {
  buildSetupEnvironmentTaskTitle,
  findMatchingDefinedEnvironment as findMatchingSetupNewEnvironment,
  isEnvironmentDefinitionFailureStatus as isSetupNewOnboardingFailureStatus,
  isEnvironmentDefinitionSuccessStatus as isSetupNewOnboardingSuccessStatus,
  isEnvironmentDefinitionTerminalSuccessStatus as isSetupNewOnboardingTerminalSuccessStatus,
} from './environment-definition';
