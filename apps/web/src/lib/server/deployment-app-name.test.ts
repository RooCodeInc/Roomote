import { buildDeploymentAppName } from './deployment-app-name';

describe('buildDeploymentAppName', () => {
  it('uses the same hostname-derived default across provider manifests', () => {
    expect(buildDeploymentAppName('https://customer.example.com')).toBe(
      'roomote-customer-example-com',
    );
    expect(buildDeploymentAppName('https://roomote.example.com')).toBe(
      'roomote-example-com',
    );
  });

  it('keeps the shared name within GitHub app naming limits', () => {
    const name = buildDeploymentAppName(
      'https://a-very-long-customer-deployment-name.example.com',
    );

    expect(name.length).toBeLessThanOrEqual(34);
    expect(name.endsWith('-')).toBe(false);
  });
});
