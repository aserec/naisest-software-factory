import { Mark } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { DEV_LOGIN, signIn } from "@/server/auth";
import { signIns } from "@/server/sign-ins";

// The error is <sign-in id>.<key> for a refusal the sign-in names; anything else is a plain failure.
function message(error: string) {
  const [id, key] = error.split(".", 2);
  const messages = signIns().find((s) => s.id === id)?.messages;
  return messages && key && Object.hasOwn(messages, key) ? messages[key] : "Sign in failed. Try again.";
}

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
          {message(error)}
        </p>
      )}
      {signIns().map(({ id, name }, n) => (
        <form
          key={id}
          className={n ? "mt-2" : "mt-6"}
          action={async () => {
            "use server";
            await signIn(id, { redirectTo: "/" });
          }}
        >
          <Button type="submit" size="lg" className="w-full">
            Sign in with {name}
          </Button>
        </form>
      ))}
      {DEV_LOGIN && (
        <form
          className="mt-2"
          action={async () => {
            "use server";
            await signIn("dev", { redirectTo: "/" });
          }}
        >
          <Button type="submit" variant="outline" size="lg" className="w-full">
            Dev sign-in
          </Button>
        </form>
      )}
    </main>
  );
}
