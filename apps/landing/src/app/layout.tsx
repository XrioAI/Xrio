import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono, Anta, Fraunces } from "next/font/google";

import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  weight: ["400", "500", "600", "700"],
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500"],
});

const anta = Anta({
  subsets: ["latin"],
  variable: "--font-anta",
  weight: "400",
});

const fraunces = Fraunces({
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-fraunces",
  weight: ["300", "600"],
});

export const metadata: Metadata = {
  description:
    "curl for the modern web. JS rendering, proxy routing, TLS fingerprinting — one command.",
  /* Every icon is generated from public/logo-macaw-mark.png — the same artwork the nav
     mark masks — flattened onto pure white rather than kept transparent, so it reads the same on
     a dark tab strip as on a light one. The white is a DISC, not a square, with transparent
     corners — so padding runs 13-15% rather than the square set's 6%, because the mark has to fit
     the inscribed circle instead of the full box.

     apple-touch stays a white SQUARE: iOS applies its own rounded mask and composites the icon on
     black, so transparent corners there come out as black corners, not as a circle.

     This replaces a separate favicon artwork (favicon-32 / logo-favicon / apple-touch-icon) that
     was drawn with heavier strokes and no orbital dots so it survived at 16px where fine linework
     closes up into mush. Those files are deleted; if this mark ever turns to mush in the tab, that
     was the reason for them and `git show 44ed780:public/favicon-32.png` gets one back. */
  icons: {
    apple: "/mark-apple-touch-icon.png",
    icon: [
      { sizes: "32x32", type: "image/png", url: "/mark-favicon-32.png" },
      { sizes: "192x192", type: "image/png", url: "/mark-icon-192.png" },
      { sizes: "512x512", type: "image/png", url: "/mark-icon-512.png" },
    ],
  },
  title: "Xrio — Fetch Everything",
};

const RootLayout = ({ children }: Readonly<{ children: React.ReactNode }>) => (
  <html
    lang="en"
    className={`${spaceGrotesk.variable} ${ibmPlexMono.variable} ${anta.variable} ${fraunces.variable}`}
    style={{
      fontFamily: "var(--font-space-grotesk), system-ui, sans-serif",
      overflowX: "hidden",
    }}
  >
    <body>{children}</body>
  </html>
);

export default RootLayout;
