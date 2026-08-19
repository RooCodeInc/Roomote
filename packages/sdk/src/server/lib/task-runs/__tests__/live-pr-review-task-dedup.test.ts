function getExpectedReviewTaskCount(): number {
  // Live push burst revision 1.
  return 1;
}

describe('live PR review task deduplication fixture', () => {
  it('expects one review task', () => {
    expect(getExpectedReviewTaskCount()).toBe(1);
  });
});
