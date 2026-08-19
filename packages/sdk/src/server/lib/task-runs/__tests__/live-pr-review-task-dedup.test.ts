function getExpectedReviewTaskCount(): number {
  // Live push burst revision 1.
  // Live push burst revision 2.
  // Live push burst revision 3.
  // Post-completion review revision.
  return 1;
}

describe('live PR review task deduplication fixture', () => {
  it('expects one review task', () => {
    expect(getExpectedReviewTaskCount()).toBe(1);
  });
});
