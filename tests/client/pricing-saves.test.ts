import { expect, test } from 'bun:test';
import {
  catalogKey,
  createPricingSaves,
  intendedRule,
  isIdle,
  projectedRule,
  type PricingWrite,
} from '../../src/lib/client/pricing-saves';
import type { PricingInfo, PricingRule } from '../../src/lib/shared/pricing';

const rates = (model: string, input: number): PricingRule => ({
  model,
  kind: 'rates',
  rates: { inputPerMillion: input, outputPerMillion: 1 },
});

// A hub whose writes settle only when the test says so.
const fakeHub = (initial: readonly PricingRule[] = []) => {
  let rules = initial;
  const sent: PricingWrite[] = [];
  const waiting: { write: PricingWrite; settle: (failure?: string) => void }[] = [];
  const info = (): PricingInfo => ({
    updatedAt: 'test',
    checkedAt: null,
    source: 'test',
    revision: 'test',
    models: [],
    rules,
    refreshError: null,
  });
  const saves = createPricingSaves(
    (write) =>
      new Promise<PricingInfo>((resolve, reject) => {
        sent.push(write);
        waiting.push({
          write,
          settle: (failure) => {
            if (failure) return reject(new Error(failure));
            if (write.type === 'set') rules = [...rules.filter((rule) => rule.model !== write.rule.model), write.rule];
            if (write.type === 'delete') rules = rules.filter((rule) => rule.model !== write.model);
            resolve(info());
          },
        });
      }),
  );
  saves.acknowledge(initial, 0);
  const next = async (failure?: string) => {
    waiting.shift()?.settle(failure);
    await Bun.sleep(0);
  };
  return { saves, sent, next, rules: () => rules };
};

test('reverting during an in-flight save sends the revert after it', async () => {
  const hub = fakeHub([rates('a', 1)]);
  expect(hub.saves.submit({ type: 'set', rule: rates('a', 2) }, '')).toBe(true);
  // Matches what the hub acknowledged, but not what it will hold.
  expect(hub.saves.submit({ type: 'set', rule: rates('a', 1) }, '')).toBe(true);
  expect(projectedRule(hub.saves.state(), 'a')).toEqual(rates('a', 1));
  await hub.next();
  await hub.next();
  expect(hub.sent).toHaveLength(2);
  expect(hub.rules()).toEqual([rates('a', 1)]);
  expect(isIdle(hub.saves.state())).toBe(true);
});

test('only the newest intent per model is sent, and one already stored is skipped', async () => {
  const hub = fakeHub([rates('a', 1)]);
  hub.saves.submit({ type: 'set', rule: rates('a', 2) }, '');
  hub.saves.submit({ type: 'set', rule: rates('a', 3) }, '');
  hub.saves.submit({ type: 'set', rule: rates('a', 2) }, '');
  expect(hub.saves.submit({ type: 'set', rule: rates('a', 2) }, '')).toBe(false);
  await hub.next();
  expect(hub.sent).toHaveLength(1);
  expect(hub.rules()).toEqual([rates('a', 2)]);
});

test("another model's success keeps a failed model's draft and error", async () => {
  const hub = fakeHub([rates('a', 4)]);
  hub.saves.submit({ type: 'set', rule: rates('a', 6) }, '');
  hub.saves.submit({ type: 'set', rule: { model: 'b', kind: 'alias', target: 'a' } }, '');
  await hub.next('Hub unavailable');
  await hub.next();
  const state = hub.saves.state();
  expect(hub.rules().map((rule) => rule.model)).toEqual(['a', 'b']);
  expect(state.failures.get('a')?.message).toBe('Hub unavailable');
  expect(intendedRule(state, 'a')).toEqual(rates('a', 6));
  // A background read neither clears the failure nor the failed draft.
  expect(hub.saves.acknowledge(hub.rules(), state.generation)).toBe(true);
  expect(hub.saves.state().failures.has('a')).toBe(true);
  expect(intendedRule(hub.saves.state(), 'a')).toEqual(rates('a', 6));
  // Retrying clears it once it succeeds; going back to the saved value discards it.
  hub.saves.submit({ type: 'set', rule: rates('a', 6) }, '');
  expect(hub.saves.state().failures.has('a')).toBe(false);
  await hub.next('Still unavailable');
  expect(hub.saves.state().failures.get('a')?.message).toBe('Still unavailable');
  expect(hub.saves.submit({ type: 'set', rule: rates('a', 4) }, '')).toBe(false);
  expect(hub.saves.state().failures.has('a')).toBe(false);
  expect(intendedRule(hub.saves.state(), 'a')).toEqual(rates('a', 4));
});

test('a failure superseded by a newer intent for the same model is not reported', async () => {
  const hub = fakeHub([rates('a', 1)]);
  hub.saves.submit({ type: 'set', rule: rates('a', 2) }, '');
  hub.saves.submit({ type: 'set', rule: rates('a', 1) }, '');
  await hub.next('Hub unavailable');
  // The queued revert already matches the hub, so nothing more is sent.
  expect(hub.sent).toHaveLength(1);
  expect(hub.saves.state().failures.size).toBe(0);
  expect(isIdle(hub.saves.state())).toBe(true);
});

test('reset and refresh queue behind a save started by blur', async () => {
  const hub = fakeHub([rates('a', 4)]);
  hub.saves.submit({ type: 'set', rule: rates('a', 7) }, '');
  expect(hub.saves.submit({ type: 'delete', model: 'a' }, '')).toBe(true);
  expect(hub.saves.submit({ type: 'refresh' }, '')).toBe(true);
  expect(hub.saves.submit({ type: 'refresh' }, '')).toBe(false);
  expect(projectedRule(hub.saves.state(), 'a')).toBeUndefined();
  await hub.next();
  await hub.next();
  await hub.next();
  expect(hub.sent.map((write) => write.type)).toEqual(['set', 'delete', 'refresh']);
  expect(hub.rules()).toEqual([]);
  // Resetting a model with no rule, saved or pending, sends nothing.
  expect(hub.saves.submit({ type: 'delete', model: 'a' }, '')).toBe(false);
});

test('refresh failures are kept apart from model failures', async () => {
  const hub = fakeHub();
  hub.saves.submit({ type: 'refresh' }, '');
  await hub.next('Catalog unavailable');
  expect(hub.saves.state().failures.get(catalogKey)?.message).toBe('Catalog unavailable');
  hub.saves.submit({ type: 'refresh' }, '');
  await hub.next();
  expect(hub.saves.state().failures.size).toBe(0);
});

test('reads that overlap a write are not acknowledged', async () => {
  const hub = fakeHub([rates('a', 1)]);
  const since = hub.saves.state().generation;
  hub.saves.submit({ type: 'set', rule: rates('a', 2) }, '');
  expect(hub.saves.acknowledge([rates('a', 1)], since)).toBe(false);
  await hub.next();
  expect(hub.saves.acknowledge([rates('a', 1)], since)).toBe(false);
  expect(hub.saves.state().rules).toEqual([rates('a', 2)]);
});

test('writes carry the pairing secret given when they were submitted', async () => {
  const secrets: string[] = [];
  const saves = createPricingSaves(async (_write, adminSecret) => {
    secrets.push(adminSecret);
    return { updatedAt: '', checkedAt: null, source: '', revision: '', models: [], rules: [], refreshError: null };
  });
  saves.submit({ type: 'refresh' }, 'first');
  await Bun.sleep(0);
  saves.submit({ type: 'refresh' }, 'second');
  await Bun.sleep(0);
  expect(secrets).toEqual(['first', 'second']);
});

test("a new model's failed draft is kept until it is retried or discarded", async () => {
  const hub = fakeHub();
  hub.saves.submit({ type: 'set', rule: rates('new', 13) }, '');
  hub.saves.submit({ type: 'set', rule: rates('b', 2) }, '');
  await hub.next('Hub unavailable');
  await hub.next();
  // The hub has no rule for it, but the editor can still restore the draft.
  expect(hub.rules().map((rule) => rule.model)).toEqual(['b']);
  expect(intendedRule(hub.saves.state(), 'new')).toEqual(rates('new', 13));
  hub.saves.discard('new');
  expect(hub.saves.state().failures.size).toBe(0);
  expect(intendedRule(hub.saves.state(), 'new')).toBeUndefined();
  expect(hub.sent).toHaveLength(2);
});

test('discarding drops unsent intent, and a sent write that fails leaves no failure', async () => {
  const hub = fakeHub();
  hub.saves.submit({ type: 'set', rule: rates('a', 1) }, '');
  hub.saves.submit({ type: 'set', rule: rates('b', 1) }, '');
  hub.saves.discard('a');
  hub.saves.discard('b');
  expect(hub.saves.state().queued).toEqual([]);
  await hub.next('Hub unavailable');
  expect(hub.sent.map((write) => write.type === 'set' && write.rule.model)).toEqual(['a']);
  expect(hub.saves.state().failures.size).toBe(0);
  expect(intendedRule(hub.saves.state(), 'a')).toBeUndefined();
  expect(isIdle(hub.saves.state())).toBe(true);
  // A later failure for the same model is reported again.
  hub.saves.submit({ type: 'set', rule: rates('a', 2) }, '');
  await hub.next('Still unavailable');
  expect(hub.saves.state().failures.get('a')?.message).toBe('Still unavailable');
});
