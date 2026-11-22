import { html, raw, type Raw } from "./html";
import { asset } from "./static";

export const SITE_NAME = "Flopwatch";
export const LINKS = {
  flopIntro: "https://flop.finance/intro/",
  technocore: "https://technocore.chat/",
  source: "https://github.com/ricardofm-1/flopwatch",
};

export interface Banner {
  label: string;
  live: boolean;
  network: string;
  statsBuiltAt: string | null;
}

/** Flopwatch mark: an eye with a square pupil (echoes the ecosystem's square bullet). Not the FLOP logo. */
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M2.5 16C6.6 9.2 11 6.2 16 6.2S25.4 9.2 29.5 16C25.4 22.8 21 25.8 16 25.8S6.6 22.8 2.5 16Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><rect x="12" y="12" width="8" height="8" fill="#00B4D8"/></svg>`;
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0A1128"/><path d="M4 16C7.7 10 11.6 7.4 16 7.4S24.3 10 28 16C24.3 22 20.4 24.6 16 24.6S7.7 22 4 16Z" fill="none" stroke="#F5F7FA" stroke-width="2.4"/><rect x="12.5" y="12.5" width="7" height="7" fill="#00B4D8"/></svg>`,
  );

export function layout(opts: { title: string; banner?: Banner; body: Raw; scripts?: string[]; active?: string }): string {
  const nav = [
    ["/", "Board"],
    ["/methodology", "Methodology"],
    ["/connect", "Connect"],
    ["/feeds/miners.json", "JSON"],
  ];
  const b = opts.banner;
  return (
    "<!doctype html>" +
    html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0A1128">
<title>${opts.title}</title>
<meta name="description" content="Flopwatch: independent per-miner reliability for the FLOP Network, built from DID-signed, chain-verified inference receipts.">
<link rel="icon" href="${FAVICON}">
<link rel="preload" href="/fonts/space-mono-latin-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${asset("/static/style.css")}">
<link rel="alternate" type="application/json" href="/feeds/miners.json">
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/" aria-label="${SITE_NAME} home">${raw(MARK)}<span class="wordmark">FLOP<span>WATCH</span></span></a>
    <nav aria-label="Main">
      ${nav.map(([href, label]) => html`<a href="${href}"${href === "/connect" ? raw(' id="nav-connect"') : ""}${opts.active === href ? raw(' aria-current="page"') : ""}>${label}</a>`)}
      <span class="nav-sep" aria-hidden="true"></span>
      <a class="nav-ext" href="${LINKS.flopIntro}" target="_blank" rel="noopener">FLOP ↗</a>
      <a class="nav-ext" href="${LINKS.technocore}" target="_blank" rel="noopener">Technocore ↗</a>
    </nav>
  </div>
</header>
${
  b
    ? html`<div class="banner ${b.live ? "live" : "sample"}" role="status"><div class="wrap banner-inner">
  <strong>${b.label}</strong>
  <span>Network · ${b.network}</span>
  <span>Aggregates built · ${b.statsBuiltAt ? raw(`<time datetime="${b.statsBuiltAt}">${b.statsBuiltAt.replace("T", " ").slice(0, 16)} UTC</time>`) : "never"}</span>
</div></div>`
    : ""
}
<main class="wrap">${opts.body}</main>
<footer>
  <div class="wrap footer-inner">
    <p><strong>${SITE_NAME}</strong> is an independent board of observed, verified receipts. It is not an official FLOP Network ranking. Times are shown in Europe/Lisbon.</p>
    <p class="footer-links">
      <a href="${LINKS.flopIntro}" target="_blank" rel="noopener">FLOP Network ↗</a>
      <a href="${LINKS.technocore}" target="_blank" rel="noopener">Technocore ↗</a>
      <a href="/methodology">Methodology</a>
      <a href="/feeds/meta.json">meta.json</a>
      <a href="${LINKS.source}" target="_blank" rel="noopener">Source ↗</a>
    </p>
  </div>
</footer>
${["/static/app.js", ...(opts.scripts ?? [])].map((s) => html`<script src="${asset(s)}" defer></script>`)}
</body>
</html>`.value
  );
}
