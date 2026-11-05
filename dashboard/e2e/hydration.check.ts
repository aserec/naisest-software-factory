import { readFileSync } from "node:fs";
import { test } from "@playwright/test";
import { encode } from "next-auth/jwt";

const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const COOKIE = "__Secure-authjs.session-token";

test("print hydration warnings", async ({ context }) => {
  test.setTimeout(180_000);
  const value = await encode({ token: { userId: 1, username: "aserec", loginAt: Date.now() }, secret: env.AUTH_SECRET, salt: COOKIE, maxAge: 3600 });
  await context.addCookies([{ name: COOKIE, value, url: "https://localhost:3000", secure: true }]);
  for (const path of ["/", "/runs/2bb6d5c8-d30b-42bc-838c-f9c9e49c36f2?step=6a5295fc-bcbc-4930-83ae-afdb2d20f688", "/insights", "/runner", "/switches", "/dispatches", "/preferences"]) {
    const page = await context.newPage();
    const msgs: string[] = [];
    page.on("console", (m) => /hydrat|didn't match/i.test(m.text()) && msgs.push(m.text().slice(0, 4000)));
    await page.goto(`https://localhost:3000${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    console.log(`== ${path} -> ${page.url()} ${msgs.length ? "" : "(no hydration warning)"}`);
    for (const m of msgs) console.log(m);
    await page.close();
  }
});
