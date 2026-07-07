import { getTaskToolByInvocation } from './task-tools';

describe('task-tools', () => {
  it('resolves Task Tool metadata from either supported invocation delimiter', () => {
    expect(getTaskToolByInvocation('$capture-visual-proof')?.label).toBe(
      'Capture visual proof',
    );
    expect(getTaskToolByInvocation('/capture-visual-proof')?.label).toBe(
      'Capture visual proof',
    );
  });

  it('ignores text that is not a Task Tool invocation', () => {
    expect(getTaskToolByInvocation('address-pr-feedback')).toBeUndefined();
  });
});
