import { describe, expect, it } from 'vitest';

import {
  clampReasoningEffortForTaskModel,
  type TaskModelMetadata,
} from '../task-models';

function buildMetadata(
  overrides: Partial<TaskModelMetadata> = {},
): TaskModelMetadata {
  return {
    contextWindow: null,
    inputTypes: null,
    inputPricePerToken: null,
    outputPricePerToken: null,
    lastRefreshedAt: null,
    ...overrides,
  };
}

describe('clampReasoningEffortForTaskModel', () => {
  it('keeps the effort when the metadata declares no restriction', () => {
    expect(clampReasoningEffortForTaskModel('medium', null)).toBe('medium');
    expect(clampReasoningEffortForTaskModel('medium', buildMetadata())).toBe(
      'medium',
    );
    expect(
      clampReasoningEffortForTaskModel(
        'xhigh',
        buildMetadata({ supportedReasoningEfforts: [] }),
      ),
    ).toBe('xhigh');
  });

  it('keeps a supported effort unchanged', () => {
    expect(
      clampReasoningEffortForTaskModel(
        'high',
        buildMetadata({ supportedReasoningEfforts: ['low', 'high', 'max'] }),
      ),
    ).toBe('high');
  });

  it('clamps an unsupported effort to the nearest supported level below', () => {
    // GitHub Copilot's kimi-k3 accepts low/high/max only.
    expect(
      clampReasoningEffortForTaskModel(
        'medium',
        buildMetadata({ supportedReasoningEfforts: ['low', 'high', 'max'] }),
      ),
    ).toBe('low');
    expect(
      clampReasoningEffortForTaskModel(
        'xhigh',
        buildMetadata({ supportedReasoningEfforts: ['low', 'high', 'max'] }),
      ),
    ).toBe('high');
  });

  it('falls back to the lowest supported level above when none exists below', () => {
    expect(
      clampReasoningEffortForTaskModel(
        'low',
        buildMetadata({ supportedReasoningEfforts: ['high', 'max'] }),
      ),
    ).toBe('high');
  });

  it('drops the effort entirely when the model has no configurable reasoning', () => {
    expect(
      clampReasoningEffortForTaskModel(
        'medium',
        buildMetadata({ supportsReasoning: false }),
      ),
    ).toBeUndefined();
    expect(
      clampReasoningEffortForTaskModel(
        'medium',
        buildMetadata({
          supportsReasoning: false,
          supportedReasoningEfforts: ['low'],
        }),
      ),
    ).toBeUndefined();
  });
});
