import pino, { type DestinationStream } from 'pino';
import pretty from 'pino-pretty';

const stream: DestinationStream = pretty({ colorize: true });

export const logger = pino({ base: undefined }, stream);
