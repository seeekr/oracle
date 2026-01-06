import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowserLogger, ResolvedBrowserConfig } from './types.js';
import { getOracleHomeDir } from '../oracleHome.js';

const DEFAULT_WAIT_MS = 1_200_000; // 20m
const LOCK_DIR_NAME = 'browser-locks';

function shouldEnableLock(): boolean {
  const raw = process.env.ORACLE_BROWSER_LOCK ?? process.env.ORACLE_BROWSER_ENABLE_LOCK;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function getLockTimeoutMs(config: ResolvedBrowserConfig): number {
  const envValue = process.env.ORACLE_BROWSER_LOCK_WAIT_MS;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return config.timeoutMs ?? DEFAULT_WAIT_MS;
}

function buildLockKey(config: ResolvedBrowserConfig): string {
  const urlHost = (() => {
    try {
      return new URL(config.url).host;
    } catch {
      return 'chatgpt.com';
    }
  })();
  const identity = config.chromeCookiePath ?? config.chromeProfile ?? 'default';
  const raw = `${identity}|${urlHost}`;
  return createHash('sha1').update(raw).digest('hex');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number };
    return typeof parsed?.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

export async function acquireBrowserLock(
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
): Promise<(() => Promise<void>) | null> {
  if (!shouldEnableLock()) return null;

  const lockDir = path.join(getOracleHomeDir(), LOCK_DIR_NAME);
  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${buildLockKey(config)}.lock`);
  const deadline = Date.now() + getLockTimeoutMs(config);
  let loggedWait = false;

  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
      await handle.close();
      if (loggedWait && logger.verbose) {
        logger('[browser] Acquired concurrency lock; proceeding.');
      }
      return async () => {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST') {
        throw error;
      }
      const pid = await readLockPid(lockPath);
      if (pid && !isPidAlive(pid)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (!loggedWait) {
        loggedWait = true;
        if (logger.verbose) {
          logger('[browser] Another browser run is active; waiting for concurrency lock...');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error('browser-lock-timeout');
}
