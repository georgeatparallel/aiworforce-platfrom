// EVERY WORKER LOG LINE CARRIES ITS TIME.
//
// The worker runs run-agent in-process, and both log through `console`. Query
// B d22d9ee6 (2026-10-12) had a 5.5-minute stretch inside slice 4 that could
// not be attributed to any phase, because no line said when it was written.
// Installed once at worker start; every console line is prefixed with an ISO
// timestamp and otherwise passed through unchanged (same arguments, same
// stream). Idempotent.

const INSTALLED = Symbol.for("agentory.worker.timestampedConsole");

export function installTimestampedConsole(
  target: Pick<Console, "log" | "info" | "warn" | "error" | "debug"> = console,
  now: () => Date = () => new Date(),
): void {
  const t = target as unknown as Record<symbol, boolean> & typeof target;
  if (t[INSTALLED]) return;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => original(now().toISOString(), ...args);
  }
  t[INSTALLED] = true;
}
