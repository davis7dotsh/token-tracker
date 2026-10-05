#!/usr/bin/env bun
import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { cli } from './app';
import { cliTeardown } from './runtime';

Command.run(cli, { version: '0.4.0' }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ teardown: cliTeardown }),
);
