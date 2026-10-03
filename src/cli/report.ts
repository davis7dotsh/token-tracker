import type { DashboardResponse } from '../lib/shared/domain';

const tokens = (value: number) => new Intl.NumberFormat('en-US').format(value);
const money = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
const harnessName = (value: string) => ({ claude: 'Claude Code', codex: 'Codex', pi: 'Pi' })[value] ?? value;

export const formatReport = (report: DashboardResponse) => {
  const row = (name: string, count: number, cost: number) =>
    `  ${name.padEnd(26)} ${tokens(count).padStart(16)} tokens  ${money(cost).padStart(12)}`;
  return [
    `${report.machine} · ${report.period.start.slice(0, 10)} – ${report.period.end.slice(0, 10)}`,
    '',
    `${tokens(report.totals.tokens)} tokens · ${money(report.totals.costUSD)} estimated API cost`,
    '',
    'Harnesses',
    ...report.harnesses.map((item) => row(harnessName(item.name), item.tokens, item.costUSD)),
    '',
    'Top models',
    ...[...report.models]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5)
      .map((item) => row(item.name, item.tokens, item.costUSD)),
    ...(report.totals.unpricedTokens
      ? ['', `${tokens(report.totals.unpricedTokens)} tokens have no known price.`]
      : []),
    ...report.warnings
      .filter((warning) => report.totals.unpricedTokens > 0 || !warning.startsWith('No reliable API price'))
      .map((warning) => `Warning: ${warning}`),
  ].join('\n');
};
