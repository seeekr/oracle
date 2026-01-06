import type { ReasoningEffort, ThinkingTimeLevel, ThinkingTimeOption } from './types.js';

const THINKING_TIME_VALUES: ThinkingTimeOption[] = [
  'light',
  'standard',
  'extended',
  'heavy',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

const THINKING_TIME_VALUE_SET = new Set(THINKING_TIME_VALUES);

const BROWSER_MAP: Record<ThinkingTimeOption, ThinkingTimeLevel> = {
  light: 'light',
  standard: 'standard',
  extended: 'extended',
  heavy: 'heavy',
  none: 'light',
  minimal: 'light',
  low: 'light',
  medium: 'standard',
  high: 'extended',
  xhigh: 'heavy',
};

const API_MAP: Record<ThinkingTimeOption, ReasoningEffort> = {
  light: 'low',
  standard: 'medium',
  extended: 'high',
  heavy: 'xhigh',
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export const THINKING_TIME_CHOICES = [...THINKING_TIME_VALUES] as const;

export function normalizeThinkingTimeInput(value?: string | null): ThinkingTimeOption | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) return undefined;
  if (THINKING_TIME_VALUE_SET.has(normalized as ThinkingTimeOption)) {
    return normalized as ThinkingTimeOption;
  }
  return undefined;
}

export function mapThinkingTimeToBrowser(value: ThinkingTimeOption): ThinkingTimeLevel {
  return BROWSER_MAP[value];
}

export function mapThinkingTimeToReasoning(value: ThinkingTimeOption): ReasoningEffort {
  return API_MAP[value];
}
