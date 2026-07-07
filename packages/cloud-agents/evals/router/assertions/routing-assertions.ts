/**
 * Custom assertions for LLM routing evaluation.
 * These assertions validate the structure and content of workspace-only routing responses.
 */

interface RoutingResponse {
  workspaceValue?: string;
  reasoning?: string;
  confidence?: number;
  needsExternalLookup?: boolean;
  externalReference?: string | null;
  requestedModelId?: string | null;
  modelConfidence?: number | null;
}

interface AssertionResult {
  pass: boolean;
  score: number;
  reason: string;
}

type AssertionFunction = (output: string) => AssertionResult;
type ContextAwareAssertionFunction = (
  output: string,
  context: { vars: Record<string, string> },
) => AssertionResult;

/**
 * Extracts JSON from LLM response, handling markdown code blocks.
 */
function extractJson(output: string): RoutingResponse | null {
  try {
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
      return JSON.parse(codeBlockMatch[1].trim()) as RoutingResponse;
    }

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      return JSON.parse(jsonMatch[0]) as RoutingResponse;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validates that the response is valid JSON with required workspace routing fields.
 */
function isValidRoutingJson(output: string): AssertionResult {
  const json = extractJson(output);
  if (!json) {
    return {
      pass: false,
      score: 0,
      reason: 'Response is not valid JSON',
    };
  }

  const requiredFields = [
    'workspaceValue',
    'reasoning',
    'confidence',
    'needsExternalLookup',
    'externalReference',
  ] as const;
  const missingFields = requiredFields.filter((field) => !(field in json));

  if (missingFields.length > 0) {
    return {
      pass: false,
      score: 0,
      reason: `Missing required fields: ${missingFields.join(', ')}`,
    };
  }

  return {
    pass: true,
    score: 1,
    reason: 'Response has all required workspace-routing fields',
  };
}

/**
 * Validates that workspaceValue is a non-empty string.
 */
function hasValidWorkspaceValue(output: string): AssertionResult {
  const json = extractJson(output);
  if (!json?.workspaceValue) {
    return {
      pass: false,
      score: 0,
      reason: 'No workspaceValue found in response',
    };
  }

  const isValid =
    typeof json.workspaceValue === 'string' &&
    json.workspaceValue.trim().length > 0;
  return {
    pass: isValid,
    score: isValid ? 1 : 0,
    reason: isValid
      ? `Valid workspaceValue: ${json.workspaceValue}`
      : `Invalid workspaceValue: ${json.workspaceValue}. Expected a non-empty string`,
  };
}

/**
 * Asserts that the workspaceValue matches the expected value.
 */
function workspaceValueEquals(
  expectedWorkspaceValue: string,
): AssertionFunction {
  return (output: string): AssertionResult => {
    const json = extractJson(output);
    if (!json) {
      return {
        pass: false,
        score: 0,
        reason: 'Invalid JSON response',
      };
    }

    const isMatch = json.workspaceValue === expectedWorkspaceValue;
    return {
      pass: isMatch,
      score: isMatch ? 1 : 0,
      reason: isMatch
        ? `workspaceValue matches: ${expectedWorkspaceValue}`
        : `workspaceValue mismatch: expected ${expectedWorkspaceValue}, got ${json.workspaceValue}`,
    };
  };
}

/**
 * Asserts that reasoning contains a specific keyword or phrase.
 */
function reasoningContains(keyword: string): AssertionFunction {
  return (output: string): AssertionResult => {
    const json = extractJson(output);
    if (!json?.reasoning) {
      return {
        pass: false,
        score: 0,
        reason: 'No reasoning found in response',
      };
    }

    const contains = json.reasoning
      .toLowerCase()
      .includes(keyword.toLowerCase());
    return {
      pass: contains,
      score: contains ? 1 : 0,
      reason: contains
        ? `Reasoning contains "${keyword}"`
        : `Reasoning does not contain "${keyword}"`,
    };
  };
}

/**
 * Asserts that workspaceValue matches the test's expectedWorkspaceValue var.
 */
function workspaceValueMatchesExpected(
  output: string,
  context: { vars: Record<string, string> },
): AssertionResult {
  const json = extractJson(output);
  if (!json) {
    return { pass: false, score: 0, reason: 'Invalid JSON response' };
  }

  const expected = context.vars.expectedWorkspaceValue;
  if (!expected) {
    return {
      pass: false,
      score: 0,
      reason: 'No expectedWorkspaceValue in test vars',
    };
  }

  const actual = json.workspaceValue;
  const isMatch = actual === expected;
  return {
    pass: isMatch,
    score: isMatch ? 1 : 0,
    reason: isMatch
      ? `workspaceValue matches: ${expected}`
      : `workspaceValue mismatch: expected ${expected}, got ${actual}`,
  };
}

/**
 * Asserts that reasoning contains the test's expectedReasoningKeyword var.
 */
function reasoningContainsExpected(
  output: string,
  context: { vars: Record<string, string> },
): AssertionResult {
  const json = extractJson(output);
  if (!json?.reasoning) {
    return { pass: false, score: 0, reason: 'No reasoning found in response' };
  }

  const keyword = context.vars.expectedReasoningKeyword;
  if (!keyword) {
    return {
      pass: false,
      score: 0,
      reason: 'No expectedReasoningKeyword in test vars',
    };
  }

  const contains = json.reasoning.toLowerCase().includes(keyword.toLowerCase());
  return {
    pass: contains,
    score: contains ? 1 : 0,
    reason: contains
      ? `Reasoning contains "${keyword}"`
      : `Reasoning does not contain "${keyword}"`,
  };
}

/**
 * Asserts that requestedModelId matches the test's expectedRequestedModelId var
 * and carries a model confidence at or above the runtime preference threshold.
 * Used for model-bearing routing cases where the user expresses a model
 * preference and the router should echo back the matching model id. Picks
 * below 0.9 confidence are demoted at runtime, so a low-confidence match
 * fails this assertion too.
 */
function requestedModelIdMatchesExpected(
  output: string,
  context: { vars: Record<string, string> },
): AssertionResult {
  const json = extractJson(output);
  if (!json) {
    return { pass: false, score: 0, reason: 'Invalid JSON response' };
  }

  const expected = context.vars.expectedRequestedModelId;
  if (!expected) {
    return {
      pass: false,
      score: 0,
      reason: 'No expectedRequestedModelId in test vars',
    };
  }

  const actual = json.requestedModelId ?? null;
  if (actual !== expected) {
    return {
      pass: false,
      score: 0,
      reason: `requestedModelId mismatch: expected ${expected}, got ${actual}`,
    };
  }

  const modelConfidence = json.modelConfidence;
  const isConfident =
    typeof modelConfidence === 'number' && modelConfidence >= 0.9;
  return {
    pass: isConfident,
    score: isConfident ? 1 : 0,
    reason: isConfident
      ? `requestedModelId matches: ${expected} (model confidence ${modelConfidence})`
      : `requestedModelId matches but model confidence is below the runtime threshold: got ${String(modelConfidence)}`,
  };
}

/**
 * Asserts that the router did not report a model preference when the user did
 * not express one: requestedModelId must be the explicit `__no_model__`
 * sentinel (or a legacy null/empty response).
 */
function requestedModelIdIsNull(output: string): AssertionResult {
  const json = extractJson(output);
  if (!json) {
    return { pass: false, score: 0, reason: 'Invalid JSON response' };
  }

  const isNoModel =
    json.requestedModelId == null ||
    json.requestedModelId === '' ||
    json.requestedModelId === '__no_model__';
  return {
    pass: isNoModel,
    score: isNoModel ? 1 : 0,
    reason: isNoModel
      ? 'requestedModelId reports no model preference'
      : `expected no model preference, got ${json.requestedModelId}`,
  };
}

export {
  isValidRoutingJson,
  hasValidWorkspaceValue,
  workspaceValueEquals,
  reasoningContains,
  workspaceValueMatchesExpected,
  reasoningContainsExpected,
  requestedModelIdMatchesExpected,
  requestedModelIdIsNull,
  extractJson,
};

export type {
  RoutingResponse,
  AssertionResult,
  AssertionFunction,
  ContextAwareAssertionFunction,
};
