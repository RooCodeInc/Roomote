import path from 'path';

import { execa } from 'execa';
import ora from 'ora';

export class DatabaseService {
  static async migrate(verbose: boolean): Promise<void> {
    const migrateDatabase = ora('Migrating database').start();

    await execa('pnpm', ['db:migrate'], {
      ...(verbose && { stdio: 'inherit' }),
      cwd: path.resolve(process.cwd(), '../..'),
    });

    migrateDatabase.succeed();
  }

  static async reset(verbose: boolean): Promise<void> {
    const resetDatabase = ora('Resetting database').start();

    await execa('pnpm', ['db:reset'], {
      ...(verbose && { stdio: 'inherit' }),
      cwd: path.resolve(process.cwd(), '../..'),
    });

    resetDatabase.succeed();
  }
}
