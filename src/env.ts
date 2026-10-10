import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
  TOKEN_TRACKER_DASHBOARD_PASSCODE: {
    description: 'Optional passcode for local and self-hosted dashboards. Required on Cloudflare.',
    schema: (value) => value,
  },
});
