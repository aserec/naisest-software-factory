// Each local factory has its own ID (FACTORY_ID, made by local-factory.sh). The factory that sets a ticket running owns it:
// another factory does not see that ticket until a person sets it ready again. A ready its owner set itself, such as the
// restart of a dead run, stays the owner's.
import type { Ticket, Tracker } from "./seams";

export function ownTickets(tracker: Tracker, id: string): Tracker {
  const mine = (t: Ticket) => !t.owner || t.owner === id;
  // A ready ticket is free unless its owner set it ready. Only another factory's tickets cost the extra reads.
  const free = async (t: Ticket) => mine(t) || (t.state === "ready" && !(await tracker.isFactory((await tracker.startedBy(t.ref)) ?? "")));
  const keep = async (list: Ticket[]) => (await Promise.all(list.map(async (t) => ((await free(t)) ? [t] : [])))).flat();
  return {
    ...tracker,
    list: async (state) => keep(await tracker.list(state)),
    listClosed: async (count) => (await tracker.listClosed(count)).filter(mine),
    // ponytail: two factories that set the same ready ticket running in the same seconds both claim it; the last label wins.
    setState: async (ref, state) => {
      if (state === "running") await tracker.setOwner(ref, id);
      await tracker.setState(ref, state);
    },
  };
}
