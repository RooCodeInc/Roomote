export { normalizeRepositorySelection } from '@roomote/types';

export {
  findMatchingDefinedEnvironment as findMatchingSetupNewEnvironment,
  isEnvironmentDefinitionFailureStatus as isSetupNewOnboardingFailureStatus,
  isEnvironmentDefinitionSuccessStatus as isSetupNewOnboardingSuccessStatus,
  isEnvironmentDefinitionTerminalSuccessStatus as isSetupNewOnboardingTerminalSuccessStatus,
} from './environment-definition';
