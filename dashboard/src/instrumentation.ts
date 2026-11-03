// Starts the background loop once, on the Node runtime only (the edge runtime has no sqlite).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ tick }, { getDb }, { getCi }] = await Promise.all([import("./server/loop"), import("./server/db-instance"), import("./server/gitlab-instance")]);
    let busy = false; // a slow tick must not overlap the next one
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await tick({ db: getDb(), gitlab: getCi(), now: new Date() });
      } catch (err) {
        console.error("loop failed", err);
      } finally {
        busy = false;
      }
    }, 10_000);
  } catch (err) {
    console.error("loop did not start", err);
  }
}
