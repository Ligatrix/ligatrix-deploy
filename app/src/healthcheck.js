#!/usr/bin/env node
// Container HEALTHCHECK command. Uses Node's own fetch so the runtime image needs
// no curl or wget. Exit 0 = healthy, 1 = unhealthy (the codes Docker expects).

import { pathToFileURL } from 'node:url';

export async function runHealthcheck({ port = 3000, path = '/healthz', timeoutMs = 2000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT || 3000);
  process.exitCode = await runHealthcheck({ port });
}
