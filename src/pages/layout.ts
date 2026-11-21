import { html, raw, type Raw } from "./html";

export interface Banner {
  label: string;
  live: boolean;
  network: string;
  statsBuiltAt: string | null;
}

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
<title>${opts.title}</title>
<meta name="description" content="Per-miner reliability for Flop inference, built from DID-signed, chain-verified receipts.">
<link rel="stylesheet" href="/static/style.css">
<link rel="alternate" type="application/json" href="/feeds/miners.json">
</head>
<body>
<header class="top">
  <a class="brand" href="/">Flop Miner Reliability Board</a>
  <nav>${nav.map(([href, label]) => html`<a href="${href}"${opts.active === href ? raw(' aria-current="page"') : ""}>${label}</a>`)}</nav>
</header>
${
  b
    ? html`<div class="banner ${b.live ? "live" : "sample"}" role="status">
  <strong>${b.label}</strong>
  <span>Network: ${b.network}</span>
  <span>Aggregates built: ${b.statsBuiltAt ? raw(`<time datetime="${b.statsBuiltAt}">${b.statsBuiltAt.replace("T", " ").slice(0, 16)} UTC</time>`) : "never"}</span>
</div>`
    : ""
}
<main>${opts.body}</main>
<footer>
  <p>Observed, verified receipts — not an official Flop ranking. Times shown in Europe/Lisbon.
  <a href="/feeds/meta.json">meta.json</a> · <a href="/methodology">methodology</a></p>
</footer>
${(opts.scripts ?? []).map((s) => html`<script src="${s}" defer></script>`)}
</body>
</html>`.value
  );
}
