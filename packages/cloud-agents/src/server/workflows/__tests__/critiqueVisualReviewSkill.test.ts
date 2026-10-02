import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const skill = fs.readFileSync(
  path.resolve(thisDir, '../skills/standard/critique-visual-review/SKILL.md'),
  'utf8',
);

describe('Critique visual review skill', () => {
  it('uses the current browser state and keeps the paid repair loop bounded', () => {
    expect(skill).toContain('existing active `agent-browser` page');
    expect(skill).toContain(
      'baseline capture -> page review -> source fix -> candidate capture -> comparison',
    );
    expect(skill).toContain('Keep the loop bounded to one repair pass');
    expect(skill).toContain('Do not start another autonomous repair loop');
  });

  it('handles advisory, partial, and failure results honestly', () => {
    expect(skill).toContain('confidence at least `0.7`');
    expect(skill).toContain('`partial` is usable');
    expect(skill).toContain('`omittedFindingCount`');
    expect(skill).toContain('Never retry it automatically');
    expect(skill).toContain('Do not retry unchanged 4xx');
    expect(skill).toContain('502/503');
    expect(skill).toContain('continue the parent coding workflow');
  });
});
