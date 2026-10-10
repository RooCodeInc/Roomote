import { renderHook } from '@testing-library/react';
import { usePeopleSendAvailable } from './usePeopleSendAvailable';

it('only appears for a current peer and pins an existing draft until cleared or sent', () => {
  const { result, rerender } = renderHook(
    ({ shared, draft }) => usePeopleSendAvailable(shared, draft),
    { initialProps: { shared: false, draft: '' } },
  );
  expect(result.current).toBe(false);
  rerender({ shared: false, draft: 'Solo draft' });
  expect(result.current).toBe(false);
  rerender({ shared: true, draft: 'Solo draft' });
  expect(result.current).toBe(true);
  rerender({ shared: false, draft: 'Solo draft' });
  expect(result.current).toBe(true);
  rerender({ shared: false, draft: '' });
  expect(result.current).toBe(false);
  rerender({ shared: true, draft: '' });
  expect(result.current).toBe(true);
  rerender({ shared: false, draft: '' });
  expect(result.current).toBe(false);
});
