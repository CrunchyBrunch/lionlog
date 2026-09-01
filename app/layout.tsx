import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PwaRegister } from "./pwa-register";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  // Vinext beta currently serializes the standard Viewport fields but omits
  // viewportFit, so include the directive in its framework-rendered width value.
  width: "device-width, viewport-fit=cover",
  initialScale: 1,
  themeColor: "#001E44",
};

const title = "LionLog — dining hall meal builder";
const description = "Turn an available dining hall menu into a practical meal.";
const metadataBase = publicApplicationUrl();

export const metadata: Metadata = {
  metadataBase,
  title,
  description,
  alternates: { canonical: "./" },
  openGraph: {
    title,
    description,
    type: "website",
    url: "./",
    images: [{ url: "./og.png", width: 1731, height: 909, alt: "LionLog practical plate meal builder" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["./og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-lionlog-shell="v0.2.0-alpha.3">
      <head>
        <link rel="manifest" href="./manifest.webmanifest" />
        <link rel="apple-touch-icon" sizes="180x180" href="./icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="LionLog" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}

function publicApplicationUrl(): URL {
  const configuredOrigin = process.env.LIONLOG_PUBLIC_ORIGIN ?? "http://localhost:3000";
  const origin = new URL(configuredOrigin);
  const isLocal = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (
    (origin.protocol !== "https:" && !(isLocal && origin.protocol === "http:"))
    || origin.username
    || origin.password
    || origin.search
    || origin.hash
    || origin.pathname !== "/"
  ) {
    throw new Error("LIONLOG_PUBLIC_ORIGIN must be an HTTPS origin, or an HTTP localhost origin for preview.");
  }

  const basePath = process.env.LIONLOG_BASE_PATH ?? "";
  if (basePath !== "" && !/^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basePath)) {
    throw new Error("LIONLOG_BASE_PATH must be empty or one absolute single path segment.");
  }
  return new URL(`${basePath}/`, origin);
}
