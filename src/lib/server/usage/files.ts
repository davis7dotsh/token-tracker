import { readdir } from 'node:fs/promises';
import { Effect } from 'effect';
import { CollectionError } from '../../shared/domain';

// Directory entries already identify regular files, folders and symlinks.
// Avoid a failed readLink and a separate stat for every entry in large log
// inventories; nested symlinks remain excluded before any traversal/read.
export const readUsageDirectory = (directory: string) =>
  Effect.tryPromise({
    try: () => readdir(directory, { withFileTypes: true }),
    catch: () => new CollectionError({ message: 'Usage directory could not be read.' }),
  });
