import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Config, Effect, Layer, Redacted } from 'effect';
import Hub from './src/cloud/hub.ts';

// The passcode-protected dashboard: SvelteKit on Workers, forwarding RPC and uploads to the
// Hub Worker. Only the `#hub` host differs from the self-hosted Bun build.
export const Dashboard = Cloudflare.Website.SvelteKit(
  'Dashboard',
  Effect.gen(function* () {
    const passcode = yield* Config.Redacted('TOKEN_TRACKER_DASHBOARD_PASSCODE').pipe(
      Effect.filterOrFail(
        (secret) => Redacted.value(secret).length >= 16 && Redacted.value(secret).length <= 1024,
        () => new Error('TOKEN_TRACKER_DASHBOARD_PASSCODE must be between 16 and 1024 characters.'),
      ),
      Effect.orDie,
    );
    return {
      env: {
        HUB: Hub,
        TOKEN_TRACKER_DASHBOARD_PASSCODE: passcode,
        LOGIN_RATE_LIMITER: Cloudflare.RateLimit('LoginAttempts', {
          namespaceId: 1008,
          simple: { limit: 5, period: 60 },
        }),
      },
      kit: { alias: { '#hub': 'src/lib/server/host/cloudflare.ts' } },
      memo: {
        include: ['src/**', 'static/**', 'assets/**', 'package.json', 'bun.lock', 'vite.config.ts', 'tsconfig.json'],
      },
    };
  }),
);

export default Alchemy.Stack(
  'TokenTracker',
  {
    providers: Cloudflare.providers(),
    // Deploys share state through the account's Cloudflare state store.
    // `alchemy dev` emulates everything locally and keeps its state in .alchemy/.
    state: Layer.unwrap(
      Effect.map(Alchemy.AlchemyContext, ({ dev }) => (dev ? Alchemy.localState() : Cloudflare.state())),
    ),
  },
  Effect.gen(function* () {
    const dashboard = yield* Dashboard;
    return { url: dashboard.url };
  }),
);
