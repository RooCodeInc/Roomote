import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { question } from '@roo-code/judgement';
import presets from './judgement-presets.generated.json';

const root = fileURLToPath(new URL('../../../..', import.meta.url));

it('keeps bundled tester inputs synchronized with rules, fixtures, generator, and library', async () => {
  for (const [path, expected] of Object.entries(presets.sourceHashes)) {
    const hash = createHash('sha256')
      .update(await readFile(join(root, path)))
      .digest('hex');
    expect(hash, `${path} changed. Run pnpm judgement:presets.`).toBe(expected);
  }
  const pkg = JSON.parse(
    await readFile(join(root, 'packages/cloud-agents/package.json'), 'utf8'),
  );
  expect(pkg.dependencies['@roo-code/judgement']).toBe(presets.library);
  const fixtureExamples = (
    await Promise.all(
      Object.keys(presets.fixtureSha256).map(
        async (id) =>
          JSON.parse(
            await readFile(
              join(root, `.judgement/examples/${id}.json`),
              'utf8',
            ),
          ).examples.length,
      ),
    )
  ).reduce((sum, count) => sum + count, 0);
  expect(presets.examples).toHaveLength(fixtureExamples);
  for (const example of presets.examples) {
    for (const packet of example.packets) {
      expect(packet.state).not.toHaveProperty('expected');
      expect(packet.state).not.toHaveProperty('name');
      const request = packet.state as Parameters<typeof question>[0];
      expect(presets.questionSets[packet.questionSet]!.standard.result).toEqual(
        question(request),
      );
      expect(presets.questionSets[packet.questionSet]!.combined.result).toEqual(
        question(request, { combineAcceptedOutcomes: true }),
      );
    }
  }
});
