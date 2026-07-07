/**
 * Custom assertions for follow-up classification evaluation.
 * These assertions validate the structure and content of follow-up responses
 * from the classifyFollowUp LLM call.
 */

const VALID_INTENTS = ['confirm', 'cancel', 'correct'] as const;

type FollowUpIntent = (typeof VALID_INTENTS)[number];

interface FollowUpResponse {
  intent?: string;
  reasoning?: string;
}

interface AssertionResult {
  pass: boolean;
  score: number;
  reason: string;
}

type AssertionFunction = (output: string) => AssertionResult;

/**
 * Extracts JSON from LLM response, handling markdown code blocks.
 */
function extractJson(output: string): FollowUpResponse | null {
  try {
    // Try to find JSON in markdown code block first
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
      return JSON.parse(codeBlockMatch[1].trim()) as FollowUpResponse;
    }

    // Try to find raw JSON object
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      return JSON.parse(jsonMatch[0]) as FollowUpResponse;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validates that the response is valid JSON with required follow-up fields.
 */
function isValidFollowUpJson(output: string): AssertionResult {
  const json = extractJson(output);
  if (!json) {
    return {
      pass: false,
      score: 0,
      reason: 'Response is not valid JSON',
    };
  }

  const requiredFields = ['intent', 'reasoning'] as const;
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
    reason: 'Response has all required fields',
  };
}

/**
 * Validates that intent is one of the valid options.
 */
function hasValidIntent(output: string): AssertionResult {
  const json = extractJson(output);
  if (!json?.intent) {
    return {
      pass: false,
      score: 0,
      reason: 'No intent found in response',
    };
  }

  const normalized = json.intent.toLowerCase().trim();
  const isValid = (VALID_INTENTS as readonly string[]).includes(normalized);
  return {
    pass: isValid,
    score: isValid ? 1 : 0,
    reason: isValid
      ? `Valid intent: ${normalized}`
      : `Invalid intent: ${json.intent}. Expected one of: ${VALID_INTENTS.join(', ')}`,
  };
}

/**
 * Asserts that the intent matches the expected value (case-insensitive).
 */
function intentEquals(expectedIntent: FollowUpIntent): AssertionFunction {
  return (output: string): AssertionResult => {
    const json = extractJson(output);
    if (!json?.intent) {
      return {
        pass: false,
        score: 0,
        reason: 'No intent found in response',
      };
    }

    const normalized = json.intent.toLowerCase().trim();
    const isMatch = normalized === expectedIntent;
    return {
      pass: isMatch,
      score: isMatch ? 1 : 0,
      reason: isMatch
        ? `intent matches: ${expectedIntent}`
        : `intent mismatch: expected ${expectedIntent}, got ${json.intent}`,
    };
  };
}

/**
 * Asserts that intent is NOT the specified value (case-insensitive).
 * Useful for ambiguous cases where multiple answers are acceptable
 * as long as one particular answer is avoided.
 */
function intentIsNot(excludedIntent: FollowUpIntent): AssertionFunction {
  return (output: string): AssertionResult => {
    const json = extractJson(output);
    if (!json?.intent) {
      return {
        pass: false,
        score: 0,
        reason: 'No intent found in response',
      };
    }

    const normalized = json.intent.toLowerCase().trim();
    const isNotExcluded = normalized !== excludedIntent;
    return {
      pass: isNotExcluded,
      score: isNotExcluded ? 1 : 0,
      reason: isNotExcluded
        ? `intent is not ${excludedIntent}: got ${normalized}`
        : `intent should not be ${excludedIntent}`,
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

// Pre-bound intent assertions for promptfoo file:// syntax compatibility
const intentEqualsConfirm = intentEquals('confirm');
const intentEqualsCancel = intentEquals('cancel');
const intentEqualsCorrect = intentEquals('correct');

// Pre-bound intent exclusion assertions
const intentIsNotConfirm = intentIsNot('confirm');
const intentIsNotCancel = intentIsNot('cancel');
const intentIsNotCorrect = intentIsNot('correct');

export {
  // Validation assertions
  isValidFollowUpJson,
  hasValidIntent,

  // Factory functions for custom assertions
  intentEquals,
  intentIsNot,
  reasoningContains,

  // Pre-bound intent assertions
  intentEqualsConfirm,
  intentEqualsCancel,
  intentEqualsCorrect,

  // Pre-bound intent exclusion assertions
  intentIsNotConfirm,
  intentIsNotCancel,
  intentIsNotCorrect,

  // Utility functions
  extractJson,
};

// Type exports
export type {
  FollowUpIntent,
  FollowUpResponse,
  AssertionResult,
  AssertionFunction,
};
