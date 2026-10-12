import { describe, expect, test } from 'bun:test';
import { createAliasValidation, rankCatalogMatches } from '../../src/lib/client/pricing-editor';
import type { PricingRule } from '../../src/lib/shared/pricing';

const catalogModels = ['gpt-6-astra', 'gpt-6-sol', 'openai/catalog-only', 'claude-fable-5'];
const validation = (rules: readonly PricingRule[] = []) =>
  createAliasValidation({
    models: [...new Set([...catalogModels, ...rules.map((rule) => rule.model)])],
    rules,
  });

describe('pricing alias editor validation', () => {
  test('accepts known prices and trims the names that will be submitted', () => {
    const validate = validation();
    expect(validate('proxy', 'gpt-6-astra')).toBeUndefined();
    expect(validate(' proxy ', ' gpt-6-sol ')).toBeUndefined();
    expect(validate('gpt-6-astra', 'gpt-6-sol')).toBeUndefined();
  });

  test('rejects missing targets and exact self-aliases even when catalog pricing exists', () => {
    const validate = validation();
    expect(validate('gpt-6-astra', '')).toBeDefined();
    expect(validate('gpt-6-astra', '   ')).toBeDefined();
    expect(validate('gpt-6-astra', 'gpt-6-astra')).toBeDefined();
    expect(validate(' gpt-6-astra ', ' gpt-6-astra ')).toBeDefined();
  });

  test('accepts custom and free rules as terminals, including chains of aliases', () => {
    const validate = validation([
      { model: 'custom', kind: 'rates', rates: { inputPerMillion: 1, outputPerMillion: 2 } },
      { model: 'free', kind: 'free' },
      { model: 'custom-proxy', kind: 'alias', target: 'custom' },
      { model: 'chained-proxy', kind: 'alias', target: 'custom-proxy' },
    ]);
    for (const target of ['custom', 'free', 'custom-proxy', 'chained-proxy']) {
      expect(validate('new-proxy', target)).toBeUndefined();
    }
  });

  test('rejects aliases to dependents while allowing those dependents to use a different terminal', () => {
    const validate = validation([
      { model: 'dependent', kind: 'alias', target: 'gpt-6-astra' },
      { model: 'indirect', kind: 'alias', target: 'dependent' },
    ]);
    expect(validate('gpt-6-astra', 'dependent')).toBeDefined();
    expect(validate('gpt-6-astra', 'indirect')).toBeDefined();
    expect(validate('new-proxy', 'indirect')).toBeUndefined();
    expect(validate('dependent', 'gpt-6-sol')).toBeUndefined();
  });

  test('saved alias edges take precedence over catalog availability', () => {
    const validate = validation([{ model: 'gpt-6-astra', kind: 'alias', target: 'gpt-6-sol' }]);
    expect(validate('gpt-6-sol', 'gpt-6-astra')).toBeDefined();
    expect(validate('new-proxy', 'gpt-6-astra')).toBeUndefined();
  });

  test('rejects existing cyclic and unresolved alias chains', () => {
    const validate = validation([
      { model: 'cycle-a', kind: 'alias', target: 'cycle-b' },
      { model: 'cycle-b', kind: 'alias', target: 'cycle-a' },
      { model: 'broken', kind: 'alias', target: 'missing' },
    ]);
    expect(validate('new-proxy', 'cycle-a')).toBeDefined();
    expect(validate('new-proxy', 'cycle-b')).toBeDefined();
    expect(validate('new-proxy', 'broken')).toBeDefined();
  });

  test('matches model IDs exactly without case folding or fuzzy guesses', () => {
    const validate = validation();
    for (const target of ['GPT-6-ASTRA', 'gpt-6-astra-probably', 'astra', 'constructor', '__proto__']) {
      expect(validate('new-proxy', target)).toBeDefined();
    }
  });

  test('allows supported catalog namespace and dated-Claude lookups', () => {
    const validate = validation();
    expect(validate('new-proxy', 'catalog-only')).toBeUndefined();
    expect(validate('new-proxy', 'openai/gpt-6-astra')).toBeUndefined();
    const metaValidate = createAliasValidation({ models: ['meta/orbit-fixture-1.0'], rules: [] });
    expect(metaValidate('uncatalogued-fixture', 'orbit-fixture-1.0')).toBeUndefined();
    expect(metaValidate('uncatalogued-fixture', 'meta/orbit-fixture-1.0')).toBeUndefined();
    expect(validate('new-proxy', 'claude-fable-5-20261005')).toBeUndefined();
    expect(validate('new-proxy', 'unrelated/gpt-6-astra')).toBeDefined();
    expect(validate('new-proxy', 'claude-fable-5-202610')).toBeDefined();
  });

  test('leaves ambiguous namespace lookups to final server validation', () => {
    const validate = validation([
      { model: 'custom', kind: 'rates', rates: { inputPerMillion: 1, outputPerMillion: 2 } },
      { model: 'claude-private', kind: 'free' },
    ]);
    expect(validate('new-proxy', 'custom')).toBeUndefined();
    expect(validate('new-proxy', 'claude-private')).toBeUndefined();
    // PricingInfo combines catalog and rule IDs. The server can determine
    // whether these fallback names have catalog prices despite custom rules.
    expect(validate('new-proxy', 'openai/custom')).toBeUndefined();
    expect(validate('new-proxy', 'claude-private-20261005')).toBeUndefined();
  });

  test('fuzzy catalog search finds models across separators, token order, and typos', () => {
    const models = ['meta/orbit-alpha-1.0', 'meta/orbit-beta-1.0', 'example-6'];
    for (const query of ['orbit-alpha', 'orbit alpha', 'alpha orbit', 'orbitalpha', 'alpha', 'obtalpha']) {
      expect(rankCatalogMatches(models, query)[0]).toBe('meta/orbit-alpha-1.0');
    }
    expect(rankCatalogMatches(models, 'not-a-model')).toEqual([]);
  });

  test('clean slugs rank ahead of namespaced duplicates, and prefix matches beat fuzzy ones', () => {
    const models = [
      'openrouter/vendor/orbit-alpha',
      'azure/orbit-alpha',
      'orbit-alpha',
      'vendor/orbit-alpha',
      'orbit-alpha-extended',
    ];
    expect(rankCatalogMatches(models, 'orbit')).toEqual([
      'orbit-alpha',
      'orbit-alpha-extended',
      'azure/orbit-alpha',
      'vendor/orbit-alpha',
      'openrouter/vendor/orbit-alpha',
    ]);
    expect(rankCatalogMatches(models, 'orb', 2)).toEqual(['orbit-alpha', 'orbit-alpha-extended']);
  });

  test('catalog eligibility is applied before ranking limits', () => {
    const invalid = Array.from({ length: 61 }, (_, index) => `orbit-${String(index).padStart(2, '0')}`);
    const models = [...invalid, 'vendor/orbit-valid'];
    expect(rankCatalogMatches(models, 'orbit', 8, (name) => name === 'vendor/orbit-valid')).toEqual([
      'vendor/orbit-valid',
    ]);
  });

  test('accepts 200-character targets and rejects longer targets before submitting', () => {
    const limit = 'm'.repeat(200);
    const overLimit = 'm'.repeat(201);
    const validate = createAliasValidation({ models: [limit, overLimit], rules: [] });
    expect(validate('new-proxy', limit)).toBeUndefined();
    expect(validate('new-proxy', ` ${limit} `)).toBeUndefined();
    expect(validate('new-proxy', overLimit)).toBeDefined();
  });
});
