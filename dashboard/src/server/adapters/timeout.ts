// Every outside call gives up after this, so a hung host cannot hold up the request or the loop part that waits on it.
export const timeout = (ms = 30_000) => AbortSignal.timeout(ms);
