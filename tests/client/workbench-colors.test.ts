import { expect, test } from 'bun:test';
import { assignChartColors, categoryColor } from '../../src/lib/client/workbench-colors';
import { seriesColor } from '../../src/lib/client/visuals';

test('providers and harnesses always receive their assigned color regardless of rank', () => {
  const first = assignChartColors('providers', [
    { name: 'anthropic' },
    { name: 'openai' },
    { name: 'meta' },
    { name: 'google' },
    { name: 'xai' },
  ]);
  const reversed = assignChartColors('providers', [
    { name: 'xai' },
    { name: 'google' },
    { name: 'meta' },
    { name: 'openai' },
    { name: 'anthropic' },
  ]);

  expect(first).toEqual(reversed);
  expect(first.get('anthropic')).toBe(categoryColor('claude'));
  expect(first.get('openai')).toBe(categoryColor('codex'));
  expect(first.get('meta')).toBe(categoryColor('muse'));
  expect(first.get('google')).toBe(categoryColor('antigravity'));
  expect(first.get('xai')).toBe(categoryColor('grok'));
  expect(first.get('meta')).not.toBe(first.get('openai'));

  const harnesses = assignChartColors('harnesses', [
    { name: 'claude' },
    { name: 'codex' },
    { name: 'muse' },
    { name: 'antigravity' },
    { name: 'grok' },
    { name: 'pi' },
    { name: 'cursor' },
  ]);
  expect(new Set(harnesses.values()).size).toBe(7);
  expect(harnesses.get('claude')).toBe(seriesColor('claude', 'harnesses'));
  expect(harnesses.get('grok')).toBe(seriesColor('grok', 'harnesses'));
});

test('models inherit their provider color family and stay distinct within a provider', () => {
  const initial = assignChartColors('models', [
    { name: 'claude-opus-4-6' },
    { name: 'gpt-5.4' },
    { name: 'claude-fable-5' },
    { name: 'grok-4' },
    { name: 'muse-1' },
    { name: 'gemini-3-pro' },
  ]);

  expect(initial.get('claude-opus-4-6')).toBe(categoryColor('anthropic'));
  expect(initial.get('gpt-5.4')).toBe(categoryColor('openai'));
  expect(initial.get('grok-4')).toBe(categoryColor('xai'));
  expect(initial.get('muse-1')).toBe(categoryColor('meta'));
  expect(initial.get('gemini-3-pro')).toBe(categoryColor('google'));
  expect(initial.get('claude-fable-5')).not.toBe(initial.get('claude-opus-4-6'));

  // Extending with another Claude model preserves existing colors and picks a new shade.
  const extended = assignChartColors('models', [{ name: 'claude-sonnet-4-6' }], initial);
  expect(extended.get('claude-opus-4-6')).toBe(initial.get('claude-opus-4-6'));
  expect(extended.get('claude-fable-5')).toBe(initial.get('claude-fable-5'));
  expect(extended.get('claude-sonnet-4-6')).not.toBe(initial.get('claude-opus-4-6'));
  expect(extended.get('claude-sonnet-4-6')).not.toBe(initial.get('claude-fable-5'));
});
