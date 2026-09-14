import { readFileSync } from 'node:fs';
const root = `iron-proxy-${process.argv[2]}/`;
for (const name of readFileSync(0, 'utf8').trimEnd().split('\n')) {
  if (!name.startsWith(root) || name.split('/').includes('..')) throw new Error('invalid archive member');
}
