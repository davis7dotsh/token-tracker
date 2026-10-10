import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Effect, Layer } from 'effect';
import Hub from './src/cloud/hub.ts';

// The public dashboard: SvelteKit on Workers, forwarding RPC and uploads to the
// Hub Worker. Only the `#hub` host differs from the self-hosted Bun build.
export const Dashboard = Cloudflare.Website.SvelteKit('Dashboard', {
  env: { HUB: Hub },
  kit: { alias: { '#hub': 'src/lib/server/host/cloudflare.ts' } },
  memo: {
    include: ['src/**', 'static/**', 'assets/**', 'package.json', 'bun.lock', 'vite.config.ts', 'tsconfig.json'],
  },
});

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
