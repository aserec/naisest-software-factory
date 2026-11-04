import { describe, expect, test } from "vitest";
import type { SignIn } from "../seams";

// A sign-in and a look into its tool: the account and profile the tool gives at sign-in for one user, and `allow` to grant or take away that user's rights.
export type SignInWorld = { signIn: SignIn; account: { access_token?: string }; profile: unknown; allow(ok: boolean): void };

// Every SignIn must pass this. `make` gives a world where the user is allowed.
export function signInContract(name: string, make: () => SignInWorld) {
  describe(`${name} sign-in contract`, () => {
    test("check lets an allowed user in, as a user of this sign-in", async () => {
      const w = make();
      const r = await w.signIn.check(w.account, w.profile);
      expect(r).toMatchObject({ user: { signIn: w.signIn.id } });
    });

    test("check refuses a user without rights, with a key that is in messages", async () => {
      const w = make();
      w.allow(false);
      const r = await w.signIn.check(w.account, w.profile);
      expect(r).toHaveProperty("refused");
      expect(Object.hasOwn(w.signIn.messages, (r as { refused: string }).refused)).toBe(true);
    });

    test("canAct reads the rights again on every call", async () => {
      const w = make();
      const r = await w.signIn.check(w.account, w.profile);
      const user = (r as { user: Parameters<SignIn["canAct"]>[0] }).user;
      expect(await w.signIn.canAct(user)).toBe(true);
      w.allow(false);
      const second = await w.signIn.canAct(user);
      expect(second).toHaveProperty("refused");
      expect(Object.hasOwn(w.signIn.messages, (second as { refused: string }).refused)).toBe(true);
    });
  });
}
