import { NextResponse } from "next/server";
import { auth } from "@/server/auth";

// Pages need a session. The factory routes use their own bearer token, so they and the sign-in routes pass through.
// An API call without a session gets a 401: a fetch would follow a redirect and read the sign-in page as data.
export default auth((req) => {
  if (req.auth) return;
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "sign in" }, { status: 401 });
  return NextResponse.redirect(new URL("/sign-in", req.nextUrl));
});

export const config = {
  matcher: ["/((?!api/events|api/factory|api/auth|sign-in|_next/static|_next/image|favicon.ico).*)"],
};
