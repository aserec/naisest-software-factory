// Starts the background loop once, on the Node runtime only (the edge runtime has no sqlite).
// Each part of the loop has its own timer and guard: a slow part must not overlap itself, and a hung CI call in one part
// (a cancel, say) must not hold up the others (imports, dispatches).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ loops, report }, { getDb }, { getCi, getBoard, CACHE_MS }] = await Promise.all([import("./server/loop"), import("./server/db-instance"), import("./server/compose")]);
    // Reads every target's board now and every 15 s, so no page waits the seconds a GitHub board takes to read.
    const warm = () => getBoard().board().catch(() => {}); // the board page shows the error itself
    warm();
    setInterval(warm, CACHE_MS);
    for (const [name, part] of Object.entries(loops)) {
      let busy = false;
      setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await part({ db: getDb(), ci: getCi(), now: new Date() });
        } catch (err) {
          report(`loop: ${name} failed`, err);
        } finally {
          busy = false;
        }
      }, 10_000);
    }
  } catch (err) {
    console.error("loop did not start", err);
  }
}
