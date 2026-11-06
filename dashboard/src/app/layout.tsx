import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
import { signOutAction } from "./sign-out";
import "./globals.css";

export const metadata: Metadata = { title: "Factory" };

// Runs before first paint so a saved Light or Dark never flashes the other theme. ThemeSync in shell.tsx writes the same "theme" key.
// suppressHydrationWarning on <html> because this sets data-theme before React hydrates.
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

// IBM Plex, fetched at build time and served by the dashboard itself, so a page never calls Google. globals.css reads the two variables.
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>
          <Shell signOut={signOutAction}>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
