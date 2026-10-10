import * as Alchemy from 'alchemy';
import * as Command from 'alchemy/Command';
import { Config, Effect, Layer } from 'effect';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scheduledEnvironment } from './src/cli/scheduler.ts';
import { configDirectory } from './src/cli/state.ts';
import { DashboardService, dashboardServiceProvider } from './src/deploy/dashboard-service.ts';

// The self-hosted hub on this machine: build the dashboard, install it outside
// the checkout, and keep it running as a user service. Usage data, the pairing
// secret, and pricing stay in the usual private data directory.
export default Alchemy.Stack(
  'TokenTrackerLocal',
  {
    providers: Layer.mergeAll(Command.providers(), dashboardServiceProvider()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const host = yield* Config.String('HOST').pipe(Config.withDefault('127.0.0.1'));
    const port = yield* Config.Port('PORT').pipe(Config.withDefault(8787));
    const origin = yield* Config.String('ORIGIN').pipe(Config.withDefault(''));
    const name = stage === 'local' ? 'token-tracker-dashboard' : `token-tracker-dashboard-${stage}`;
    const build = yield* Command.Build('DashboardBuild', {
      command: 'bun run build',
      outdir: 'build',
      memo: { include: ['src/**', 'static/**', 'package.json', 'bun.lock', 'patches/**', 'vite.config.ts'] },
    });
    const passthrough = [
      'XDG_CACHE_HOME',
      'TOKEN_TRACKER_DOWNLOAD_DIR',
      'TOKEN_TRACKER_PAIRING_SECRET',
      'TOKEN_TRACKER_T3_DATA_DIR',
      'TOKEN_TRACKER_T3_URL',
    ].flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value] as const] : [];
    });
    const service = yield* DashboardService('Dashboard', {
      name,
      build: build.outdir,
      revision: build.hash.output,
      appDirectory: join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), name),
      bun: process.execPath,
      host,
      port,
      environment: Object.fromEntries([
        ...scheduledEnvironment(configDirectory()).map(({ name, value }) => [name, value] as const),
        ...passthrough,
        ...(origin ? [['ORIGIN', origin] as const] : []),
      ]),
    });
    return { url: service.url, unit: service.unit };
  }),
);
