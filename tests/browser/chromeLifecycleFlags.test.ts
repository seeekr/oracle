import { describe, expect, test, vi, beforeEach } from 'vitest';
import { DEFAULT_BROWSER_CONFIG } from '../../src/browser/config.js';

vi.mock('chrome-launcher', () => {
  return {
    launch: vi.fn(async (_opts: unknown) => ({
      pid: 1234,
      port: 9222,
      chromeProcess: {},
      kill: vi.fn(),
    })),
    // biome-ignore lint/style/useNamingConvention: match chrome-launcher export name.
    Launcher: class {},
  };
});

describe('launchChrome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('adds --no-startup-window when hideWindow is enabled', async () => {
    const { launchChrome } = await import('../../src/browser/chromeLifecycle.js');
    const logger = vi.fn();

    await launchChrome(
      { ...DEFAULT_BROWSER_CONFIG, hideWindow: true, headless: false },
      '/tmp/oracle-profile',
      logger,
    );

    const { launch } = await import('chrome-launcher');
    const calls = vi.mocked(launch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const flags = calls[0]?.[0]?.chromeFlags ?? [];

    expect(flags).toContain('--no-startup-window');
    expect(flags).toContain('--window-position=-10000,-10000');
  });

  test('does not add --no-startup-window in headless mode', async () => {
    const { launchChrome } = await import('../../src/browser/chromeLifecycle.js');
    const logger = vi.fn();

    await launchChrome(
      { ...DEFAULT_BROWSER_CONFIG, hideWindow: true, headless: true },
      '/tmp/oracle-profile',
      logger,
    );

    const { launch } = await import('chrome-launcher');
    const calls = vi.mocked(launch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const flags = calls[0]?.[0]?.chromeFlags ?? [];

    expect(flags).not.toContain('--no-startup-window');
  });
});
