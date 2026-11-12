import { headers } from "next/headers";
import type { Language } from "software-factory/run-events";
import { Mark } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { type T, translator } from "@/lib/i18n";
import { DEV_LOGIN, signIn } from "@/server/auth";
import { signIns } from "@/server/sign-ins";

// The error is <sign-in id>.<key> for a refusal the sign-in names; anything else is a plain failure.
function message(error: string, t: T) {
  const [id, key] = error.split(".", 2);
  const messages = signIns().find((s) => s.id === id)?.messages;
  return messages && key && Object.hasOwn(messages, key) ? messages[key] : t("Sign in failed. Try again.");
}

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  // No account yet, so no saved language: the browser's first language the dashboard has.
  const lang = ((await headers()).get("accept-language")?.match(/(?:^|,)\s*(en|es|de)\b/i)?.[1].toLowerCase() ?? "en") as Language;
  const t = translator(lang);
  return (
    <main className="mx-auto mt-[14vh] max-w-sm rounded-xl border bg-background p-8 max-sm:mx-4">
      <h1 className="flex items-center gap-2 text-[22px] leading-7 font-semibold">
        <Mark /> {t("Factory")}
      </h1>
      <p className="mt-2 text-muted-foreground">{t("Watch the runs, stop or restart them, and set the switches. Only people who can work on the factory's targets.")}</p>
      {error && (
        <p role="alert" className="mt-4 text-destructive">
          {message(error, t)}
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
            {t("Sign in with {name}", { name })}
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
            {t("Dev sign-in")}
          </Button>
        </form>
      )}
    </main>
  );
}
