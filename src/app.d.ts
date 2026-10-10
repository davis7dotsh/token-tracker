// Cloudflare bindings for the hosted dashboard (see alchemy.run.ts).
// Self-hosted Bun builds run without a platform.
declare global {
  namespace App {
    interface Platform {
      env: {
        readonly HUB: { fetch(request: Request): Promise<Response> };
      };
    }
  }
}

export {};
