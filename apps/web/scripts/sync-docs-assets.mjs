import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(import.meta.dirname, '../../docs/logo');
const destination = resolve(import.meta.dirname, '../public/docs/logo');

if (existsSync(source)) {
  cpSync(source, destination, { recursive: true });
}
