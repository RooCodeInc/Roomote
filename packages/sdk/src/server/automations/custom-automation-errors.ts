export const DUPLICATE_CUSTOM_AUTOMATION_NAME_MESSAGE =
  'A custom automation with this name already exists.';

export type CustomAutomationWriteErrorCode =
  | 'duplicate_name'
  | 'environment_not_found'
  | 'invalid_input'
  | 'limit_reached'
  | 'not_found';

export class CustomAutomationWriteError extends Error {
  constructor(
    readonly code: CustomAutomationWriteErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CustomAutomationWriteError';
  }
}

export function customAutomationValidationError(
  message: string,
  options?: ErrorOptions,
): CustomAutomationWriteError {
  return new CustomAutomationWriteError('invalid_input', message, options);
}
