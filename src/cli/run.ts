#!/usr/bin/env bun
import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { cli } from './app';
import { cliTeardown } from './runtime';
import { collectorVersion } from '../lib/shared/version';

Command.run(cli, { version: collectorVersion }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ teardown: cliTeardown }),
);
