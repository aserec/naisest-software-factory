import type { SignInWorld } from "./sign-in.contract";

// A sign-in in memory: one user, allowed until `allow(false)`.
export function fakeSignIn(): SignInWorld {
  let allowed = true;
  const refuse = { refused: "role" };
  return {
    account: {},
    profile: { id: 1, name: "ann" },
    allow: (ok) => void (allowed = ok),
    signIn: {
      id: "fake",
      name: "Fake",
      provider: () => ({ id: "fake", name: "Fake", type: "credentials", credentials: {}, authorize: () => null }),
      check: async () => (allowed ? { user: { userId: 1, username: "ann", signIn: "fake" } } : refuse),
      canAct: async () => allowed || refuse,
      messages: { role: "You may not." },
    },
  };
}
