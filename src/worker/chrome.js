// Pick a Chrome binary for Lighthouse to drive.
//
// Priority order:
//   1. `CHROME_PATH` env var (explicit override; honoured by chrome-launcher).
//   2. The Playwright-bundled Chromium binary, if it exists on disk. This is
//      what the Docker image ships with — pinned, reproducible.
//   3. Fall through to chrome-launcher's autodetect, which finds the system
//      Google Chrome on macOS / Linux desktops (the local-dev path).
//
// Called once at worker start. Sets `CHROME_PATH` on `process.env` so the
// child `lhci collect` process inherits it.

import { existsSync } from 'node:fs';

import { chromium } from 'playwright-chromium';

import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export function resolveChromePath() {
  if (config.chromePath) {
    if (!existsSync(config.chromePath)) {
      logger.warn({ chromePath: config.chromePath }, 'CHROME_PATH is set but file does not exist');
    } else {
      logger.info({ chromePath: config.chromePath }, 'using CHROME_PATH from env');
    }
    process.env.CHROME_PATH = config.chromePath;
    return config.chromePath;
  }

  // playwright-chromium#executablePath returns the path even when the binary
  // hasn't been downloaded yet, so we have to existsSync-check before using it.
  try {
    const candidate = chromium.executablePath();
    if (candidate && existsSync(candidate)) {
      process.env.CHROME_PATH = candidate;
      logger.info({ chromePath: candidate }, 'using playwright-chromium binary');
      return candidate;
    }
    logger.info({ candidate }, 'playwright-chromium binary not present; falling back to chrome-launcher autodetect');
  } catch (err) {
    logger.warn({ err }, 'playwright-chromium lookup failed; falling back to chrome-launcher autodetect');
  }

  return null;
}
