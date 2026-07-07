import { config } from '@roomote/config-eslint/base';
import { clientConfig } from '@roomote/config-eslint/client';

/** @type {import("eslint").Linter.Config} */
export default [...config, ...clientConfig];
