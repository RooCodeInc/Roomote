import pino from 'pino';
import { config } from '../config';
import { getRequestContext } from './request-context';

export const logger = pino({
  level:
    config.LOG_LEVEL || (config.NODE_ENV === 'production' ? 'info' : 'debug'),
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  mixin() {
    return getRequestContext() || {};
  },
});

export function escapeForLog(input: string): string {
  return (
    input
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F-\x9F]/g, (char) => {
        return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
      })
  );
}
