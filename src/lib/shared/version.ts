import { version } from '../../../package.json';

// `scripts/build-cli.ts` defines this as the short git commit of a compiled
// collector. Source runs and the hub bundle leave it undefined.
declare const TOKEN_TRACKER_BUILD: string | undefined;

export const releaseVersion = version;

// One short string, e.g. `0.4.1+0cebd19`. Anything that is not a plain build
// identifier is dropped, so a bad embed still reports the release.
export const formatCollectorVersion = (release: string, build?: string) => {
  const tag = build?.trim() ?? '';
  return (/^[0-9A-Za-z.-]{1,40}$/.test(tag) ? `${release}+${tag}` : release).slice(0, 64);
};

export const collectorVersion = formatCollectorVersion(
  releaseVersion,
  typeof TOKEN_TRACKER_BUILD === 'string' ? TOKEN_TRACKER_BUILD : undefined,
);
