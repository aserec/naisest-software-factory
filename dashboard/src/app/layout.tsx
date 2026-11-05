import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
import { signOutAction } from "./sign-out";
import "./globals.css";

export const metadata: Metadata = { title: "Factory" };

// Runs before first paint so a saved Light or Dark never flashes the other theme. ThemeSync in shell.tsx writes the same "theme" key.
// suppressHydrationWarning on <html> because this sets data-theme before React hydrates.
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

// IBM Plex from Google Fonts at runtime, so the build never needs the network; system fonts stand in if it fails.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>
        <Providers>
          <Shell signOut={signOutAction}>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
