import {
  getRoutingAutoConfirmDelayMs,
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS,
} from '../types';

describe('routing auto-confirm policy', () => {
  it('starts high-confidence environment routes immediately', () => {
    expect(
      getRoutingAutoConfirmDelayMs(
        { confidence: 0.95, workspaceRemapped: false },
        'environment',
      ),
    ).toBe(0);
  });

  it('keeps the correction window for all-repositories routes', () => {
    expect(
      getRoutingAutoConfirmDelayMs(
        { confidence: 0.99, workspaceRemapped: false },
        'all_repositories',
      ),
    ).toBe(ROUTING_AUTO_CONFIRM_TIMEOUT_MS);
  });

  it('keeps the correction window below the confidence threshold', () => {
    expect(
      getRoutingAutoConfirmDelayMs({ confidence: 0.949 }, 'environment'),
    ).toBe(ROUTING_AUTO_CONFIRM_TIMEOUT_MS);
  });

  it('keeps the correction window when the workspace was remapped', () => {
    expect(
      getRoutingAutoConfirmDelayMs(
        { confidence: 0.99, workspaceRemapped: true },
        'environment',
      ),
    ).toBe(ROUTING_AUTO_CONFIRM_TIMEOUT_MS);
  });
});
