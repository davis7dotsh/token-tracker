import type { SessionExport } from '../shared/domain';
import { cursorAgentUrl, nativeThreadUrl, repositoryWebUrl, safeWebUrl } from './session-links';

export function exportSessions(data: SessionExport, deviceName: (id: string) => string) {
  const escape = (value: string | number) => {
    const text = String(value);
    return `"${text.replace(/^\s*[=+@-]/, "'$&").replaceAll('"', '""')}"`;
  };
  const rows = [
    [
      'session',
      'harness',
      'models',
      'project',
      'repository',
      'device',
      'tokens',
      'estimated_cost_usd',
      'unpriced_tokens',
      'last_active',
      'session_title',
      'project_name',
      't3_thread_id',
      't3_thread_url',
      't3_native_thread_url',
      'repository_url',
      'cursor_agent_url',
    ],
    ...data.sessions.map((session) => [
      session.id,
      session.harness,
      session.model,
      session.project,
      session.repository ?? '',
      deviceName(session.deviceId),
      session.tokens,
      session.costUSD,
      session.unpricedTokens,
      session.lastActiveAt,
      session.sessionTitle ?? '',
      session.projectName ?? '',
      session.t3ThreadId ?? '',
      safeWebUrl(session.t3ThreadUrl) ?? '',
      nativeThreadUrl(session) ?? '',
      repositoryWebUrl(session.repository) ?? '',
      cursorAgentUrl(session) ?? '',
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob([rows.map((row) => row.map(escape).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `token-usage-${data.period.start}-${data.period.end}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
