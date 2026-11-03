// local-run.sh runs this before it goes on from a later step. The event step, which sets the running state, is skipped then.
import { makeContext } from "./compose";
import { loadRecord } from "./record";
import { ticketRef } from "./steps/context";

const ctx = makeContext(process.env);
ctx.record = loadRecord();
await ctx.tracker.setState(ticketRef(ctx), "running");
