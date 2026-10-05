import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveJudgementCli } from './repository-judgement';

export function judgementBinDir(homeDir: string) {
  return join(homeDir, '.roomote', 'judgement', 'bin');
}

/** Remove commands from a prior task before checking the current backend. */
export function clearJudgementCommand(homeDir: string) {
  const roomote = join(homeDir, '.roomote');
  const stat = lstatSync(roomote, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error('Unsafe task command directory');
  }
  rmSync(join(roomote, 'judgement'), { recursive: true, force: true });
}

/** Use the bundled CLI and worker Node, without installing packages at startup. */
export function installJudgementCommand(
  homeDir: string,
  env: NodeJS.ProcessEnv,
) {
  const cli = resolveJudgementCli();
  if (!cli) throw new Error('Bundled Judgement CLI unavailable');
  const bin = judgementBinDir(homeDir);
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'judgement'),
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(cli).href)});\n`,
    { mode: 0o755 },
  );
  env.PATH = [bin, env.PATH].filter(Boolean).join(delimiter);
}
