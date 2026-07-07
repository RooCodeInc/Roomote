export interface OpenCodeModelSelection {
  providerID: string;
  modelID: string;
  qualifiedModel: string;
}

export function resolveOpenCodeModelSelection(
  model: string,
): OpenCodeModelSelection {
  const trimmedModel = model.trim();

  if (!trimmedModel) {
    throw new Error('OpenCode model must be non-empty.');
  }

  const separatorIndex = trimmedModel.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === trimmedModel.length - 1) {
    throw new Error(
      `OpenCode model "${trimmedModel}" must use provider/model format.`,
    );
  }

  return {
    providerID: trimmedModel.slice(0, separatorIndex),
    modelID: trimmedModel.slice(separatorIndex + 1),
    qualifiedModel: trimmedModel,
  };
}
