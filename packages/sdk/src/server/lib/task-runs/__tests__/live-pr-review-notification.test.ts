function isLiveReviewNotificationEnabled(): boolean {
  return true;
}

describe('isLiveReviewNotificationEnabled', () => {
  it('enables live review notifications', () => {
    expect(isLiveReviewNotificationEnabled()).toBe(true);
  });
});
