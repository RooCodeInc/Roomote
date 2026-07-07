export type { LinearSessionConnection as LinearInstallation } from './linear-sessions';
export {
  findFirst,
  hasActiveConnection as hasActiveInstallation,
  emitAction,
  emitThought,
  emitResponse,
  emitElicitation,
  updateSessionPlan,
  drainLinearMessages,
} from './linear-sessions';
