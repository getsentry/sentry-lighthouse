// pino logger. Pretty in dev, structured JSON in prod (so Northflank's log pipe
// gets clean key=value pairs).

import { pino } from 'pino';

import { config } from './config.js';

const isDev = config.nodeEnv !== 'production';

export const logger = pino({
  level: config.logLevel,
  base: { svc: 'sentry-lighthouse', sha: config.gitSha },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,svc,sha' },
    },
  }),
});
