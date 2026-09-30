import { environmentFactory } from './environment.factory';

describe('environmentFactory', () => {
  it('generates distinct default names', () => {
    const environments = environmentFactory.buildList(2);

    expect(
      new Set(environments.map((environment) => environment.name)).size,
    ).toBe(2);
  });

  it('preserves an explicitly provided name', () => {
    const environment = environmentFactory.build({ name: 'test environment' });

    expect(environment.name).toBe('test environment');
  });
});
