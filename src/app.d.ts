// Cloudflare bindings for the hosted dashboard (see alchemy.run.ts).
// Self-hosted Bun builds run without a platform.
declare global {
  namespace App {
    interface Locals {
      passcodeEnabled: boolean;
      dashboardAuthenticated: boolean;
    }
    interface Platform {
      env: {
        readonly HUB: { fetch(request: Request): Promise<Response> };
        readonly TOKEN_TRACKER_DASHBOARD_PASSCODE: string;
        readonly LOGIN_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
      };
    }
  }
}

export {};
