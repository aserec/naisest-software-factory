// The factory polls each target every minute, and asks for the target's controls on each poll (control route).
// Five quiet minutes: the loop or the CI schedule of that target is down. A target never seen is down too.
export const DOWN_AFTER_MS = 5 * 60_000;

export interface FactoryStatus { target: string; down: boolean; lastSeen?: string }

export const factoryStatus = (targets: string[], seen: Record<string, string>, now: Date): FactoryStatus[] =>
  targets.map((target) => {
    const lastSeen = seen[target];
    return { target, down: !lastSeen || now.getTime() - Date.parse(lastSeen) > DOWN_AFTER_MS, ...(lastSeen ? { lastSeen } : {}) };
  });
