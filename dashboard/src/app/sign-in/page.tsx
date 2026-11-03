import { Mark } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { DEV_LOGIN, GITHUB_LOGIN, GITHUB_REFUSAL, GITLAB_LOGIN, REFUSAL, signIn } from "@/server/auth";

const messages: Record<string, string> = {
  role: REFUSAL,
  "github-role": GITHUB_REFUSAL,
  unconfirmed: "GitLab did not confirm your role. Try again.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto mt-[14vh] max-w-sm rounded-xl border bg-background p-8 max-sm:mx-4">
      <h1 className="flex items-center gap-2 text-[22px] leading-7 font-semibold">
        <Mark /> Factory
      </h1>
      <p className="mt-2 text-muted-foreground">Watch the runs, stop or restart them, and set the switches. Only people who can work on the factory's targets.</p>
      {error && (
        <p role="alert" className="mt-4 text-destructive">
          {messages[error] ?? "Sign in failed. Try again."}
        </p>
      )}
      {GITLAB_LOGIN && (
        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("gitlab", { redirectTo: "/" });
          }}
        >
          <Button type="submit" size="lg" className="w-full">
            Sign in with GitLab
          </Button>
        </form>
      )}
      {GITHUB_LOGIN && (
        <form
          className={GITLAB_LOGIN ? "mt-2" : "mt-6"}
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <Button type="submit" size="lg" className="w-full">
            Sign in with GitHub
          </Button>
        </form>
      )}
      {DEV_LOGIN && (
        <form
          className="mt-2"
          action={async () => {
            "use server";
            await signIn("dev", { redirectTo: "/" });
          }}
        >
          <Button type="submit" variant="outline" size="lg" className="w-full">
            Dev sign-in (no GitLab)
          </Button>
        </form>
      )}
    </main>
  );
}
