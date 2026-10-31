import { DEV_LOGIN, REFUSAL, signIn } from "@/server/auth";

const messages: Record<string, string> = {
  role: REFUSAL,
  unconfirmed: "GitLab did not confirm your role. Try again.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Factory</h1>
      {error && (
        <p role="alert" className="mt-4 text-red-600">
          {messages[error] ?? "Sign in failed. Try again."}
        </p>
      )}
      <form
        className="mt-4"
        action={async () => {
          "use server";
          await signIn("gitlab", { redirectTo: "/" });
        }}
      >
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">
          Sign in with GitLab
        </button>
      </form>
      {DEV_LOGIN && (
        <form
          className="mt-2"
          action={async () => {
            "use server";
            await signIn("dev", { redirectTo: "/" });
          }}
        >
          <button type="submit" className="rounded border px-4 py-2">
            Dev sign-in (no GitLab)
          </button>
        </form>
      )}
    </main>
  );
}
