import type { PricingInfo, PricingRule } from '../shared/pricing';
import { tabClient } from './dashboard-rpc';
import { sameRule } from './pricing-editor';

export type PricingWrite = { type: 'set'; rule: PricingRule } | { type: 'delete'; model: string } | { type: 'refresh' };
export type PricingWriteResult = { write: PricingWrite } & (
  | { ok: true; info: PricingInfo }
  | { ok: false; message: string }
);
type Failure = { write: PricingWrite; message: string };

// Catalog refreshes share the queue with rule writes but never a model's key.
export const catalogKey = Symbol('catalog');
type Key = string | typeof catalogKey;
const keyOf = (write: PricingWrite): Key =>
  write.type === 'refresh' ? catalogKey : write.type === 'set' ? write.rule.model : write.model;
const ruleOf = (write: PricingWrite) => (write.type === 'set' ? write.rule : undefined);

export type PricingSavesState = {
  // Rules as last acknowledged by the hub.
  rules: readonly PricingRule[];
  inFlight: PricingWrite | undefined;
  queued: readonly PricingWrite[];
  failures: ReadonlyMap<Key, Failure>;
  // Increments whenever a write settles, so reads started earlier are stale.
  generation: number;
};

const ruleFor = (rules: readonly PricingRule[], model: string) => rules.find((rule) => rule.model === model);

// The newest write for a model that has been sent or is waiting to be sent.
export const pendingWrite = (state: PricingSavesState, model: string) =>
  state.queued.find((write) => keyOf(write) === model) ??
  (state.inFlight && keyOf(state.inFlight) === model ? state.inFlight : undefined);

// What the hub will hold once every pending write for the model lands.
export const projectedRule = (state: PricingSavesState, model: string) => {
  const pending = pendingWrite(state, model);
  return pending ? ruleOf(pending) : ruleFor(state.rules, model);
};

// What the editor should show for a model: pending intent, then a failed
// edit that has not been retried or discarded, then the saved rule.
export const intendedRule = (state: PricingSavesState, model: string) => {
  const pending = pendingWrite(state, model);
  if (pending) return ruleOf(pending);
  const failed = state.failures.get(model)?.write;
  return failed?.type === 'set' ? failed.rule : ruleFor(state.rules, model);
};

export const isIdle = (state: PricingSavesState) => !state.inFlight && !state.queued.length;

const messageFor = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'Could not update pricing. Try again.';

// Pricing writes run one at a time in submission order, keeping only the
// newest intent per model. A write is skipped when it would not change what
// the hub holds once earlier writes land. Failures stay per model until that
// model is written again, so another model's success never hides them.
export const createPricingSaves = (send: (write: PricingWrite, adminSecret: string) => Promise<PricingInfo>) => {
  let rules: readonly PricingRule[] = [];
  let inFlight: PricingWrite | undefined;
  // A discarded write that was already sent; if it fails, nothing is kept.
  let dropped: PricingWrite | undefined;
  let generation = 0;
  const queued = new Map<Key, { write: PricingWrite; adminSecret: string }>();
  const failures = new Map<Key, Failure>();
  const listeners = new Set<(state: PricingSavesState, result?: PricingWriteResult) => void>();

  const state = (): PricingSavesState => ({
    rules,
    inFlight,
    queued: [...queued.values()].map((entry) => entry.write),
    failures: new Map(failures),
    generation,
  });
  const notify = (result?: PricingWriteResult) => {
    const snapshot = state();
    for (const listener of listeners) listener(snapshot, result);
  };

  const settle = (write: PricingWrite, result: PricingWriteResult) => {
    const key = keyOf(write);
    inFlight = undefined;
    generation += 1;
    if (result.ok) {
      rules = result.info.rules;
      failures.delete(key);
    } else if (!queued.has(key) && write !== dropped) failures.set(key, { write, message: result.message });
    dropped = undefined;
    pump(result);
  };

  const pump = (result?: PricingWriteResult) => {
    if (!inFlight)
      for (const [key, entry] of queued) {
        queued.delete(key);
        // An earlier write may already have stored this intent.
        if (key !== catalogKey && sameRule(ruleFor(rules, key), ruleOf(entry.write))) continue;
        const write = entry.write;
        inFlight = write;
        void send(write, entry.adminSecret).then(
          (info) => settle(write, { write, ok: true, info }),
          (failure: unknown) => settle(write, { write, ok: false, message: messageFor(failure) }),
        );
        break;
      }
    notify(result);
  };

  return {
    state,
    subscribe(listener: (state: PricingSavesState, result?: PricingWriteResult) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    // Accept a read of the hub's rules only if no write settled since it began
    // and none is pending; otherwise the read may predate a write.
    acknowledge(next: readonly PricingRule[], since: number) {
      if (since !== generation || inFlight || queued.size) return false;
      rules = next;
      notify();
      return true;
    },
    // Returns whether a write was queued.
    submit(write: PricingWrite, adminSecret: string) {
      const key = keyOf(write);
      const current = state();
      const unchanged =
        write.type === 'refresh'
          ? queued.has(catalogKey) || inFlight?.type === 'refresh'
          : sameRule(projectedRule(current, write.type === 'set' ? write.rule.model : write.model), ruleOf(write));
      if (unchanged) {
        // Matching what is already saved satisfies a failed edit.
        if (key !== catalogKey && !pendingWrite(current, key) && failures.delete(key)) notify();
        return false;
      }
      failures.delete(key);
      queued.set(key, { write, adminSecret });
      pump();
      return true;
    },
    // Drops a model's failed edit and any unsent intent for it. A write already
    // sent cannot be recalled: if it lands the rule is saved like any other,
    // and if it fails no failure is kept.
    discard(model: string) {
      const changed = [failures.delete(model), queued.delete(model)].some(Boolean);
      if (inFlight && keyOf(inFlight) === model) dropped = inFlight;
      if (changed) notify();
    },
  };
};
export type PricingSaves = ReturnType<typeof createPricingSaves>;

let shared: PricingSaves | undefined;
// Pending pricing writes still reach the hub after Settings closes, and
// failures are shown when Pricing is opened again. One per browser tab.
export const sharedPricingSaves = () => {
  const client = tabClient();
  if (!client) return undefined;
  shared ??= createPricingSaves((write, adminSecret) =>
    write.type === 'set'
      ? client.setPricingRule(write.rule, adminSecret)
      : write.type === 'delete'
        ? client.deletePricingRule(write.model, adminSecret)
        : client.refreshPricing(adminSecret),
  );
  return shared;
};
