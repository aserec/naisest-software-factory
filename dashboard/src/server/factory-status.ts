// The factory polls each target every minute, and asks for the target's controls on each poll (control route).
// Five quiet minutes: the loop or the CI schedule of that target is down. A target never seen is unchecked, not down.
export const DOWN_AFTER_MS = 5 * 60_000;

// A tick that never said it ended (the process died) stops counting as polling after this.
export const POLL_MAX_MS = 5 * 60_000;

// polling: a poll tick of the target is in progress, for the menu's spinner.
export interface FactoryStatus { target: string; down: boolean; polling: boolean; lastSeen?: string }

export const factoryStatus = (targets: string[], seen: Record<string, string>, now: Date, polling: Record<string, string> = {}): FactoryStatus[] =>
  targets.map((target) => {
    const lastSeen = seen[target];
    const since = polling[target];
    return { target, down: !!lastSeen && now.getTime() - Date.parse(lastSeen) > DOWN_AFTER_MS, polling: !!since && now.getTime() - Date.parse(since) < POLL_MAX_MS, ...(lastSeen ? { lastSeen } : {}) };
  });
