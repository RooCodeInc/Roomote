import { nextStickyIdOrder } from './useRecentSessions';

describe('nextStickyIdOrder', () => {
  it('keeps the current order when existing ids are only reshuffled', () => {
    expect(nextStickyIdOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('adopts the live order when a new id appears', () => {
    expect(nextStickyIdOrder(['a', 'b'], ['c', 'a', 'b'])).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('drops ids that are no longer present without reshuffling the rest', () => {
    expect(nextStickyIdOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
  });
});
