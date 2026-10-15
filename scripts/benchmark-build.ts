import { Schema } from 'effect';
import { resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const directory = resolve(process.argv[2] ?? '.svelte-kit/output/client');
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        name: Schema.optionalKey(Schema.String),
        imports: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
);
const manifest = decodeManifest(await Bun.file(resolve(directory, '.vite/manifest.json')).text());
const files = new Set<string>();
const include = (key: string) => {
  const entry = manifest[key];
  if (!entry) throw new Error(`Build manifest is missing ${key}`);
  if (files.has(entry.file)) return;
  files.add(entry.file);
  for (const dependency of entry.imports ?? []) include(dependency);
};
const names = ['entry/start', 'entry/app', 'nodes/0', 'nodes/1', 'nodes/2'];
for (const name of names) {
  const key = Object.keys(manifest).find((key) => manifest[key]?.name === name);
  if (!key) throw new Error(`Build manifest has no ${name} entry. Run bun run build first.`);
  include(key);
}
const report = async (phase: string) => {
  const sizes = await Promise.all(
    [...files].map(async (file) => {
      const bytes = new Uint8Array(await Bun.file(resolve(directory, file)).arrayBuffer());
      return {
        rawBytes: bytes.byteLength,
        gzipBytes: gzipSync(bytes).byteLength,
        brotliBytes: brotliCompressSync(bytes).byteLength,
      };
    }),
  );
  console.log(
    JSON.stringify({
      phase,
      scripts: files.size,
      ...sizes.reduce(
        (total, size) => ({
          rawBytes: total.rawBytes + size.rawBytes,
          gzipBytes: total.gzipBytes + size.gzipBytes,
          brotliBytes: total.brotliBytes + size.brotliBytes,
        }),
        { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 },
      ),
    }),
  );
};
await report('hydration');
if (manifest['src/lib/components/UsageChart.svelte']) include('src/lib/components/UsageChart.svelte');
await report('with-chart');
if (manifest['src/lib/components/PricingDialog.svelte']) include('src/lib/components/PricingDialog.svelte');
await report('with-pricing');
