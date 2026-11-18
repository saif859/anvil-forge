// Anvil: a GitHub-compatible git forge in one Node process.
//
// Lifecycle under the make.fun suite (MAKEFUN_ENV_URL set):
//   1. listen on an ephemeral port (never 8080, the suite's own);
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register, retrying with backoff until the suite answers
//      (200, or 409 when a register already won);
//   3. poll GET $MAKEFUN_ENV_URL/done with a gentle backoff; on {"done": true} close and exit 0.
// Without MAKEFUN_ENV_URL the forge simply serves: on ANVIL_PORT, or an ephemeral port it prints.

import { createForge } from './src/app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
const forge = createForge(process.env);

// A stray exception in one request must never take the forge down: the suite would score nothing.
process.on('uncaughtException', (err) => process.stderr.write(`[anvil] uncaught: ${err.stack ?? err.message}\n`));
process.on('unhandledRejection', (reason) => process.stderr.write(`[anvil] unhandled rejection: ${String(reason)}\n`));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    forge.server.once('error', reject);
    forge.server.listen(port, () => {
      const address = forge.server.address();
      if (address === null || typeof address === 'string') reject(new Error('the listener has no TCP port'));
      else resolve(address.port);
    });
  });
}

function shutdown(code: number): void {
  forge.store.journal.close();
  forge.server.close();
  process.exit(code);
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer();
      if (response.status === 200 || response.status === 409) return;
      process.stderr.write(`[anvil] register answered HTTP ${response.status}; retrying\n`);
    } catch {
      // the suite is not listening yet
    }
    await sleep(Math.min(1_000, 50 * 2 ** attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(10_000) });
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) return;
    } catch {
      // not answering right now: keep polling
    }
    await sleep(Math.min(2_000, 250 * 2 ** Math.min(attempt, 3)));
  }
}

async function main(): Promise<void> {
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  if (envUrl === '') {
    const port = await listen(Number(process.env.ANVIL_PORT ?? 0));
    process.stdout.write(`[anvil] serving on http://127.0.0.1:${port} as ${forge.store.viewer.login}\n`);
    return;
  }
  const port = await listen(0);
  process.stdout.write(`[anvil] listening on ${port}; registering with the suite\n`);
  await register(port);
  process.stdout.write('[anvil] registered; serving until the suite is done\n');
  await waitForDone();
  process.stdout.write('[anvil] the suite is done\n');
  shutdown(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[anvil] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
