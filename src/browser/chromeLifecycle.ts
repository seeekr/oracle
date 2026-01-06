import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import CDP from 'chrome-remote-interface';
import { launch, Launcher, type LaunchedChrome } from 'chrome-launcher';
import type Protocol from 'devtools-protocol';
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from './types.js';
import { cleanupStaleProfileState } from './profileState.js';

const execFileAsync = promisify(execFile);

export async function launchChrome(config: ResolvedBrowserConfig, userDataDir: string, logger: BrowserLogger) {
  const connectHost = resolveRemoteDebugHost();
  const debugBindAddress = connectHost && connectHost !== '127.0.0.1' ? '0.0.0.0' : connectHost;
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const chromeFlags = buildChromeFlags(config.headless ?? false, debugBindAddress, config.hideWindow ?? false);
  const usePatchedLauncher = Boolean(connectHost && connectHost !== '127.0.0.1');
  const launcher = usePatchedLauncher
    ? await launchWithCustomHost({
        chromeFlags,
        chromePath: config.chromePath ?? undefined,
        userDataDir,
        host: connectHost ?? '127.0.0.1',
        requestedPort: debugPort ?? undefined,
      })
    : await launch({
        chromePath: config.chromePath ?? undefined,
        chromeFlags,
        userDataDir,
        handleSIGINT: false,
        port: debugPort ?? undefined,
      });
  const pidLabel = typeof launcher.pid === 'number' ? ` (pid ${launcher.pid})` : '';
  const hostLabel = connectHost ? ` on ${connectHost}` : '';
  logger(`Launched Chrome${pidLabel} on port ${launcher.port}${hostLabel}`);
  return Object.assign(launcher, { host: connectHost ?? '127.0.0.1' }) as LaunchedChrome & { host?: string };
}

export function registerTerminationHooks(
  chrome: LaunchedChrome,
  userDataDir: string,
  keepBrowser: boolean,
  logger: BrowserLogger,
  opts?: {
    /** Return true when the run is still in-flight (assistant response pending). */
    isInFlight?: () => boolean;
    /** Persist runtime hints so reattach can find the live Chrome. */
    emitRuntimeHint?: () => Promise<void>;
    /** Preserve the profile directory even when Chrome is terminated. */
    preserveUserDataDir?: boolean;
  },
): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  let handling: boolean | undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) {
      return;
    }
    handling = true;
    const inFlight = opts?.isInFlight?.() ?? false;
    const leaveRunning = keepBrowser || inFlight;
    if (leaveRunning) {
      logger(`Received ${signal}; leaving Chrome running${inFlight ? ' (assistant response pending)' : ''}`);
    } else {
      logger(`Received ${signal}; terminating Chrome process`);
    }
    void (async () => {
      if (leaveRunning) {
        // Ensure reattach hints are written before we exit.
        await opts?.emitRuntimeHint?.().catch(() => undefined);
        if (inFlight) {
          logger('Session still in flight; reattach with "oracle session <slug>" to continue.');
        }
      } else {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
        if (opts?.preserveUserDataDir) {
          // Preserve the profile directory (manual login), but clear reattach hints so we don't
          // try to reuse a dead DevTools port on the next run.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'never' }).catch(() => undefined);
        } else {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    })().finally(() => {
      const exitCode = signal === 'SIGINT' ? 130 : 1;
      // Vitest treats any `process.exit()` call as an unhandled failure, even if mocked.
      // Keep production behavior (hard-exit on signals) while letting tests observe state changes.
      process.exitCode = exitCode;
      const isTestRun = process.env.VITEST === '1' || process.env.NODE_ENV === 'test';
      if (!isTestRun) {
        process.exit(exitCode);
      }
    });
  };

  for (const signal of signals) {
    process.on(signal, handleSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, handleSignal);
    }
  };
}

export async function hideChromeWindow(chrome: LaunchedChrome, logger: BrowserLogger): Promise<void> {
  if (process.platform !== 'darwin') {
    logger('Window hiding is only supported on macOS');
    return;
  }
  if (!chrome.pid) {
    logger('Unable to hide window: missing Chrome PID');
    return;
  }

  const moved = await moveChromeWindowOffscreen(chrome.pid).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`[browser] hide-window: failed to move window off-screen (${message}).`);
    }
    return false;
  });
  if (logger.verbose) {
    logger(`[browser] hide-window: ${moved ? 'moved window off-screen' : 'unable to move window off-screen'}.`);
  }

  if ((process.env.ORACLE_BROWSER_FORCE_HIDE ?? '').trim() !== '1') {
    return;
  }
  const script = `tell application "System Events"
    try
      set visible of (first process whose unix id is ${chrome.pid}) to false
    end try
  end tell`;
  try {
    await execFileAsync('osascript', ['-e', script]);
    logger('Chrome window hidden (Cmd-H)');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to hide Chrome window: ${message}`);
  }
}

export async function connectToChrome(port: number, logger: BrowserLogger, host?: string): Promise<ChromeClient> {
  const client = await CDP({ port, host });
  logger('Connected to Chrome DevTools protocol');
  return client;
}

export interface ChromeTargetConnection {
  client: ChromeClient;
  targetId?: string;
}

export async function connectToChromeTarget(
  port: number,
  logger: BrowserLogger,
  host?: string,
  createTarget?: Protocol.Target.CreateTargetRequest | null,
): Promise<ChromeTargetConnection> {
  if (!createTarget) {
    const client = await connectToChrome(port, logger, host);
    return { client };
  }

  const url = createTarget.url || 'about:blank';
  const params: Protocol.Target.CreateTargetRequest = { ...createTarget, url };
  let targetId: string | undefined;
  let browserClient: ChromeClient | null = null;

  try {
    browserClient = await CDP({
      port,
      host,
      target: (targets) => targets.find((target) => target.type === 'browser') ?? targets[0],
    });
    if (logger.verbose) {
      logger('Connected to Chrome DevTools protocol (browser target)');
    }
    if (!browserClient.Target?.createTarget) {
      throw new Error('Target.createTarget unavailable');
    }
    try {
      const created = await browserClient.Target.createTarget(params);
      targetId = created?.targetId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (logger.verbose) {
        logger(`[browser] Target.createTarget failed (${message}); retrying with minimal params.`);
      }
      const created = await browserClient.Target.createTarget({ url });
      targetId = created?.targetId;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`[browser] Target.createTarget unavailable (${message}); falling back to CDP.New.`);
    }
    try {
      const target = await CDP.New({ host, port, url });
      targetId = (target as { id?: string }).id;
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      logger(`Failed to create Chrome target (${fallbackMessage}); attaching to existing target.`);
    }
  } finally {
    if (browserClient && typeof browserClient.close === 'function') {
      await browserClient.close().catch(() => undefined);
    }
  }

  if (targetId) {
    const client = await CDP({ port, host, target: targetId });
    logger(`Connected to Chrome DevTools protocol (target ${targetId})`);
    return { client, targetId };
  }

  const client = await connectToChrome(port, logger, host);
  return { client };
}

export async function minimizeChromeWindow(
  client: ChromeClient,
  targetId: string | undefined,
  logger: BrowserLogger,
): Promise<boolean> {
  if (!client.Browser?.getWindowForTarget || !client.Browser?.setWindowBounds) {
    return false;
  }
  try {
    const request = targetId ? { targetId } : {};
    const { windowId } = await client.Browser.getWindowForTarget(request);
    await client.Browser.setWindowBounds({
      windowId,
      bounds: { windowState: 'minimized' },
    });
    if (logger.verbose) {
      logger('[browser] hide-window: minimized window via CDP.');
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`[browser] hide-window: failed to minimize window via CDP (${message}).`);
    }
    return false;
  }
}

export async function connectToRemoteChrome(
  host: string,
  port: number,
  logger: BrowserLogger,
  targetUrl?: string,
): Promise<RemoteChromeConnection> {
  if (targetUrl) {
    try {
      const target = await CDP.New({ host, port, url: targetUrl });
      const client = await CDP({ host, port, target: target.id });
      logger(`Opened dedicated remote Chrome tab targeting ${targetUrl}`);
      return { client, targetId: target.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to open dedicated remote Chrome tab (${message}); falling back to first target.`);
    }
  }
  const fallbackClient = await CDP({ host, port });
  logger(`Connected to remote Chrome DevTools protocol at ${host}:${port}`);
  return { client: fallbackClient };
}

export async function closeRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string | undefined,
  logger: BrowserLogger,
): Promise<void> {
  if (!targetId) {
    return;
  }
  try {
    await CDP.Close({ host, port, id: targetId });
    if (logger.verbose) {
      logger(`Closed remote Chrome tab ${targetId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close remote Chrome tab ${targetId}: ${message}`);
  }
}

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId?: string;
}

function buildChromeFlags(headless: boolean, debugBindAddress?: string | null, hideWindow = false): string[] {
  const flags = [
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--disable-features=TranslateUI,AutomationControlled',
    '--mute-audio',
    '--window-size=1280,720',
    '--lang=en-US',
    '--accept-lang=en-US,en',
  ];

  if (hideWindow && !headless) {
    // Avoid initial window activation when the caller only wants a hidden instance.
    flags.push('--no-startup-window');
    // Move the window off-screen instead of hiding it to avoid visibility throttling.
    flags.push('--window-position=-10000,-10000');
  }

  if (process.platform !== 'win32' && !isWsl()) {
    flags.push('--password-store=basic', '--use-mock-keychain');
  }

  if (debugBindAddress) {
    flags.push(`--remote-debugging-address=${debugBindAddress}`);
  }

  if (headless) {
    flags.push('--headless=new');
  }

  return flags;
}

async function moveChromeWindowOffscreen(pid: number): Promise<boolean> {
  const script = `tell application "System Events"
    set targetProc to first process whose unix id is ${pid}
    set moved to false
    repeat 40 times
      try
        if (count of windows of targetProc) > 0 then
          set position of window 1 of targetProc to {-10000, -10000}
          set moved to true
          exit repeat
        end if
      end try
      delay 0.05
    end repeat
    return moved
  end tell`;
  const { stdout } = await execFileAsync('osascript', ['-e', script]);
  return stdout.trim() === 'true';
}

function parseDebugPortEnv(): number | null {
  const raw = process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}

function resolveRemoteDebugHost(): string | null {
  const override = process.env.ORACLE_BROWSER_REMOTE_DEBUG_HOST?.trim() || process.env.WSL_HOST_IP?.trim();
  if (override) {
    return override;
  }
  if (!isWsl()) {
    return null;
  }
  try {
    const resolv = readFileSync('/etc/resolv.conf', 'utf8');
    for (const line of resolv.split('\n')) {
      const match = line.match(/^nameserver\s+([0-9.]+)/);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    // ignore; fall back to localhost
  }
  return null;
}

function isWsl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  const release = os.release();
  return release.toLowerCase().includes('microsoft');
}

async function launchWithCustomHost({
  chromeFlags,
  chromePath,
  userDataDir,
  host,
  requestedPort,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string | null;
  requestedPort?: number;
}): Promise<LaunchedChrome & { host?: string }> {
  const launcher = new Launcher({
    chromePath: chromePath ?? undefined,
    chromeFlags,
    userDataDir,
    handleSIGINT: false,
    port: requestedPort ?? undefined,
  });

  if (host) {
    const patched = launcher as unknown as { isDebuggerReady?: () => Promise<void>; port?: number };
    patched.isDebuggerReady = function patchedIsDebuggerReady(this: Launcher & { port?: number }): Promise<void> {
      const debugPort = this.port ?? 0;
      if (!debugPort) {
        return Promise.reject(new Error('Missing Chrome debug port'));
      }
      return new Promise((resolve, reject) => {
        const client = net.createConnection({ port: debugPort, host });
        const cleanup = () => {
          client.removeAllListeners();
          client.end();
          client.destroy();
          client.unref();
        };
        client.once('error', (err) => {
          cleanup();
          reject(err);
        });
        client.once('connect', () => {
          cleanup();
          resolve();
        });
      });
    };
  }

  await launcher.launch();

  const kill = async () => launcher.kill();
  return {
    pid: launcher.pid ?? undefined,
    port: launcher.port ?? 0,
    process: launcher.chromeProcess as unknown as NonNullable<LaunchedChrome['process']>,
    kill,
    host: host ?? undefined,
    remoteDebuggingPipes: launcher.remoteDebuggingPipes,
  } as unknown as LaunchedChrome & { host?: string };
}
