import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { config } from '../config';
import { getRequestContext } from './request-context';

const loggerOptions: pino.LoggerOptions = {
  level:
    config.LOG_LEVEL || (config.NODE_ENV === 'production' ? 'info' : 'debug'),
  mixin() {
    return getRequestContext() || {};
  },
};

const developmentPrettyStream =
  config.NODE_ENV === 'development'
    ? pinoPretty({
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      })
    : undefined;

export const logger = developmentPrettyStream
  ? pino(loggerOptions, developmentPrettyStream)
  : pino(loggerOptions);

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
