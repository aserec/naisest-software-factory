import { describe, expect, test } from "vitest";
import { NotFactoryRunError, type CiRunner, type TicketRef } from "../seams";

// Every CiRunner must pass this: the fake on every push, the real adapter in the manual job.
// make gives a runner started for `ticket`, a secret name it holds, and a run the factory did not start.
export function ciContract(make: () => Promise<{ ci: CiRunner; ticket: TicketRef; secret: string; foreignRun: string }>) {
  describe("ci runner contract", () => {
    test("vars.ticket is the ticket from the trigger", async () => {
      const { ci, ticket } = await make();
      expect(ci.vars.ticket).toBe(ticket);
    });

    test("a secret is returned once, then it is gone", async () => {
      const { ci, secret } = await make();
      expect(ci.secret(secret)).toBeTruthy();
      expect(ci.secret(secret)).toBeUndefined();
    });

    test("the record of a run the factory did not start is refused", async () => {
      const { ci, foreignRun } = await make();
      await expect(ci.buildRecord(foreignRun)).rejects.toBeInstanceOf(NotFactoryRunError);
    });
  });
}
