import { NextResponse } from "next/server";
import { auth } from "@/server/auth";

// Pages need a session. The factory routes use their own bearer token, so they and the sign-in routes pass through.
export default auth((req) => {
  if (!req.auth) return NextResponse.redirect(new URL("/sign-in", req.nextUrl));
});

export const config = {
  matcher: ["/((?!api/events|api/factory|api/auth|sign-in|_next/static|_next/image|favicon.ico).*)"],
};
