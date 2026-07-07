import {
  CloudTaskType,
  DEFAULT_VISIBLE_CLOUD_TASK_TYPES,
} from '@roomote/types';

import {
  getTaskTypeFilterButtonLabel,
  isDefaultTaskTypeFilterSelection,
  parseTaskTypeFilterParam,
  serializeTaskTypeFilterParam,
} from './taskTypeFilter';

describe('taskTypeFilter helpers', () => {
  it('parses valid task types and ignores invalid entries', () => {
    expect(
      parseTaskTypeFilterParam(
        `invalid,${CloudTaskType.StandardTask},${CloudTaskType.StandardTask}`,
      ),
    ).toEqual([CloudTaskType.StandardTask]);
  });

  it('treats all-invalid values as malformed input', () => {
    expect(parseTaskTypeFilterParam('invalid')).toBeNull();
  });

  it('preserves an explicit empty selection when parsing', () => {
    expect(parseTaskTypeFilterParam('')).toEqual([]);
  });

  it('treats the default visible selection as the unset state', () => {
    expect(
      isDefaultTaskTypeFilterSelection(DEFAULT_VISIBLE_CLOUD_TASK_TYPES),
    ).toBe(true);
    expect(
      serializeTaskTypeFilterParam(DEFAULT_VISIBLE_CLOUD_TASK_TYPES),
    ).toBeNull();
  });

  it('preserves an explicit empty selection', () => {
    expect(serializeTaskTypeFilterParam([])).toBe('');
    expect(getTaskTypeFilterButtonLabel([])).toBe('No Types');
  });

  it('uses the raw task type value when only one type is selected', () => {
    expect(getTaskTypeFilterButtonLabel([CloudTaskType.GithubPrReview])).toBe(
      CloudTaskType.GithubPrReview,
    );
  });
});
