import { DEFAULT_VISIBLE_TASK_WORKFLOWS } from '@/lib/task-categories';

import {
  getTaskTypeFilterButtonLabel,
  isDefaultTaskTypeFilterSelection,
  parseTaskTypeFilterParam,
  serializeTaskTypeFilterParam,
} from './taskTypeFilter';

describe('taskTypeFilter helpers', () => {
  it('parses valid workflows and ignores invalid entries', () => {
    expect(parseTaskTypeFilterParam('invalid,standard,standard')).toEqual([
      'standard',
    ]);
  });

  it('treats all-invalid values as malformed input', () => {
    expect(parseTaskTypeFilterParam('invalid')).toBeNull();
  });

  it('preserves an explicit empty selection when parsing', () => {
    expect(parseTaskTypeFilterParam('')).toEqual([]);
  });

  it('treats the default visible selection as the unset state', () => {
    expect(
      isDefaultTaskTypeFilterSelection(DEFAULT_VISIBLE_TASK_WORKFLOWS),
    ).toBe(true);
    expect(
      serializeTaskTypeFilterParam(DEFAULT_VISIBLE_TASK_WORKFLOWS),
    ).toBeNull();
  });

  it('preserves an explicit empty selection', () => {
    expect(serializeTaskTypeFilterParam([])).toBe('');
    expect(getTaskTypeFilterButtonLabel([])).toBe('No Types');
  });

  it('uses the raw workflow value when only one workflow is selected', () => {
    expect(getTaskTypeFilterButtonLabel(['pr_review'])).toBe('pr_review');
  });
});
