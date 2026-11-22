import type { Env } from "../env";
import { explorerLink, networkConfig, type Network } from "../env";
import { buildMeta, buildMinerFeed } from "../stats/feeds";
import { WINDOWS, type StatsWindow } from "../stats/aggregate";
import { esc, flop, html, lisbon, ms, pct, raw, short, type Raw } from "./html";
import { layout } from "./layout";

interface Row {
  network: string;
  miner: string;
  model: string;
  window: string;
  n: number;
  success_rate: number | null;
  settlement_rate: number | null;
  latency_p50: number | null;
  latency_p95: number | null;
  price_session_median: number | null;
  price_token_median: number | null;
  last_seen: string | null;
}

const SORTS: Record<string, keyof Row> = {
  miner: "miner",
  model: "model",
  n: "n",
  success: "success_rate",
  settlement: "settlement_rate",
  p50: "latency_p50",
  p95: "latency_p95",
  price: "price_session_median",
  token: "price_token_median",
  seen: "last_seen",
};

function addr(env: Env, network: string, a: string): Raw {
  const link = explorerLink(networkConfig(env, network as Network).accountUrl, "address", a);
  return html`<span class="addr"><a href="/miner/${encodeURIComponent(a)}?network=${network}" title="${a}">${short(a)}</a><button type="button" class="copy" data-copy="${a}" aria-label="Copy address">⧉</button>${
    link ? html`<a class="ext" href="${link}" rel="noopener" target="_blank" aria-label="Explorer">↗</a>` : ""
  }</span>`;
}

export async function homePage(env: Env, q: URLSearchParams): Promise<string> {
  const meta = await buildMeta(env);
  const network = q.get("network") === "devnet" ? "devnet" : "testnet";
  const win = (WINDOWS as readonly string[]).includes(q.get("window") ?? "") ? (q.get("window") as StatsWindow) : "all";
  const model = q.get("model") ?? "";
  const minN = Math.max(0, Number.parseInt(q.get("minN") ?? "0", 10) || 0);
  const sortKey = SORTS[q.get("sort") ?? ""] ? (q.get("sort") as string) : "success";
  const dir = q.get("dir") === "asc" ? "asc" : "desc";

  const { results: all } = await env.DB.prepare(
    "SELECT * FROM miner_stats WHERE network = ? AND window = ? AND (? = 0 OR is_sample = 0)",
  )
    .bind(network, win, meta.live ? 1 : 0)
    .all<Row>();
  const models = [...new Set(all.map((r) => r.model))].sort();
  const col = SORTS[sortKey]!;
  const rows = all
    .filter((r) => (!model || r.model === model) && r.n >= minN)
    .sort((a, b) => {
      const x = a[col], y = b[col];
      if (x === y) return b.n - a.n;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = x < y ? -1 : 1;
      return dir === "asc" ? c : -c;
    });

  const NUMERIC = new Set(["n", "success", "settlement", "p50", "p95", "price", "token"]);
  const link = (key: string, label: string) => {
    const p = new URLSearchParams(q);
    p.set("sort", key);
    p.set("dir", sortKey === key && dir === "desc" ? "asc" : "desc");
    const arrow = sortKey === key ? (dir === "desc" ? " ▾" : " ▴") : "";
    return html`<th scope="col"${NUMERIC.has(key) ? raw(' class="num"') : ""} aria-sort="${sortKey === key ? (dir === "desc" ? "descending" : "ascending") : "none"}"><a href="?${p.toString()}">${label}${arrow}</a></th>`;
  };

  const body = html`
<section class="intro">
  <h1>Miner reliability</h1>
  <p>Per-miner results from wallet-funded inference purchases. Each counted row comes from a DID-signed receipt that was checked on chain.
  ${network === "devnet" ? html`<strong>Devnet data does not count toward anything.</strong>` : ""}</p>
</section>
<form class="filters" method="get" action="/">
  <label>Network <select name="network">
    <option value="testnet"${network === "testnet" ? raw(" selected") : ""}>testnet</option>
    <option value="devnet"${network === "devnet" ? raw(" selected") : ""}>devnet</option></select></label>
  <label>Window <select name="window">${WINDOWS.map((w) => html`<option value="${w}"${w === win ? raw(" selected") : ""}>${w}</option>`)}</select></label>
  <label>Model <select name="model"><option value="">all models</option>${models.map(
    (m) => html`<option value="${m}"${m === model ? raw(" selected") : ""}>${m}</option>`,
  )}</select></label>
  <label>Min n <input type="number" name="minN" min="0" value="${minN}" inputmode="numeric"></label>
  <input type="hidden" name="sort" value="${sortKey}"><input type="hidden" name="dir" value="${dir}">
  <button type="submit">Apply</button>
</form>
<div class="table-wrap">
<table class="board">
  <thead><tr>
    ${link("miner", "Miner")}${link("model", "Model")}${link("n", "n")}${link("success", "Success")}${link("settlement", "Settlement")}
    ${link("p50", "p50")}${link("p95", "p95")}${link("price", "FLOP / session")}${link("token", "FLOP / token")}${link("seen", "Last seen")}
  </tr></thead>
  <tbody>
  ${
    rows.length
      ? rows.map(
          (r) => html`<tr>
    <td data-label="Miner">${addr(env, r.network, r.miner)}</td>
    <td data-label="Model"><code>${r.model}</code></td>
    <td data-label="n" class="num">${r.n}${r.n < 5 ? html` <span class="warn" title="Fewer than 5 receipts: not meaningful yet">low n</span>` : ""}</td>
    <td data-label="Success" class="num">${pct(r.success_rate)}</td>
    <td data-label="Settlement" class="num">${pct(r.settlement_rate)}</td>
    <td data-label="p50" class="num">${ms(r.latency_p50)}</td>
    <td data-label="p95" class="num">${ms(r.latency_p95)}</td>
    <td data-label="FLOP / session" class="num">${flop(r.price_session_median)}</td>
    <td data-label="FLOP / token" class="num">${flop(r.price_token_median)}</td>
    <td data-label="Last seen">${lisbon(r.last_seen)}</td>
  </tr>`,
        )
      : html`<tr><td colspan="10" class="empty">No counted receipts for this view yet.</td></tr>`
  }
  </tbody>
</table>
</div>
<p class="hint">Success = settled with a returned inference ÷ decided attempts. Prices are medians of actual paid FLOP — never the max cap. <a href="/methodology">How rows count</a>.</p>`;

  return layout({
    title: "Flop Miner Reliability Board",
    banner: { label: meta.dataLabel, live: meta.live, network, statsBuiltAt: meta.statsBuiltAt },
    body,
    scripts: ["/static/app.js"],
    active: "/",
  });
}

export async function minerPage(env: Env, miner: string, q: URLSearchParams): Promise<string | null> {
  const network = q.get("network") === "devnet" ? "devnet" : q.get("network") === "testnet" ? "testnet" : undefined;
  const feed = await buildMinerFeed(env, miner, { network });
  if (!feed) return null;
  const meta = await buildMeta(env);
  const byModel = new Map<string, typeof feed.stats>();
  for (const s of feed.stats) {
    const k = `${s.network} · ${s.model}`;
    byModel.set(k, [...(byModel.get(k) ?? []), s]);
  }
  const explorer = feed.stats[0]?.explorer;
  const body = html`
<section class="intro">
  <p><a href="/">← Board</a></p>
  <h1 class="mono">${short(miner)}</h1>
  <p class="addr-full"><code>${miner}</code> <button type="button" class="copy" data-copy="${miner}">Copy</button>
  ${explorer ? html`<a href="${explorer}" rel="noopener" target="_blank">Explorer ↗</a>` : ""}
  · <a href="/feeds/miners/${encodeURIComponent(miner)}.json">JSON</a></p>
</section>
${[...byModel.entries()].map(
  ([k, stats]) => html`<section><h2>${k}</h2>
<div class="table-wrap"><table class="board compact"><thead><tr><th>Window</th><th class="num">n</th><th class="num">Success</th><th class="num">Settlement</th><th class="num">p50</th><th class="num">p95</th><th class="num">FLOP / session</th><th class="num">FLOP / token</th><th>Last seen</th></tr></thead>
<tbody>${WINDOWS.map((w) => {
    const s = stats.find((x) => x.window === w);
    return s
      ? html`<tr><td data-label="Window">${w}</td><td data-label="n" class="num">${s.n}${s.lowSample ? html` <span class="warn">low n</span>` : ""}</td><td data-label="Success" class="num">${pct(s.successRate)}</td><td data-label="Settlement" class="num">${pct(s.settlementRate)}</td><td data-label="p50" class="num">${ms(s.latencyMsP50)}</td><td data-label="p95" class="num">${ms(s.latencyMsP95)}</td><td data-label="FLOP / session" class="num">${flop(s.flopPerSessionMedian)}</td><td data-label="FLOP / token" class="num">${flop(s.flopPerTokenMedian)}</td><td data-label="Last seen">${lisbon(s.lastSeen)}</td></tr>`
      : html`<tr><td data-label="Window">${w}</td><td colspan="8" class="empty">no counted receipts</td></tr>`;
  })}</tbody></table></div></section>`,
)}
<section>
<h2>Receipts</h2>
<p class="hint">Newest first. Prompts, outputs, buyer wallets and submitter DIDs are never shown.</p>
<div class="table-wrap"><table class="board compact receipts"><thead><tr><th>Started</th><th>Model</th><th>Status</th><th class="num">Latency</th><th class="num">Paid FLOP</th><th>Channel / tx</th><th>Verification</th><th>Counted</th></tr></thead>
<tbody>${feed.receipts.map(
    (r) => html`<tr>
<td data-label="Started">${lisbon(r.startedAt as string)}</td>
<td data-label="Model"><code>${r.model}</code></td>
<td data-label="Status"><span class="pill ${r.ok ? "ok" : "bad"}">${r.status}</span>${r.errorClass ? html` <small>${r.errorClass}</small>` : ""}</td>
<td data-label="Latency" class="num">${ms(r.latencyMs as number | null)}</td>
<td data-label="Paid FLOP" class="num">${r.paidFlop ?? "n/a"}</td>
<td data-label="Channel / tx" class="mono">${r.channelId ? html`ch ${String(r.channelId)}` : ""}${
      r.settlementTx
        ? r.settlementTxUrl
          ? html` <a href="${r.settlementTxUrl}" rel="noopener" target="_blank">${short(String(r.settlementTx))}</a>`
          : html` ${short(String(r.settlementTx))}`
        : ""
    }</td>
<td data-label="Verification">${r.verification}${r.verificationNote ? html`<br><small>${r.verificationNote}</small>` : ""}</td>
<td data-label="Counted">${r.counted ? "yes" : html`no${r.excludedReason ? html`<br><small>${r.excludedReason}</small>` : ""}`}${r.sample ? html` <span class="warn">sample</span>` : ""}</td>
</tr>`,
  )}</tbody></table></div>
</section>`;
  return layout({
    title: `Miner ${short(miner)} — Flop Miner Board`,
    banner: { label: meta.dataLabel, live: meta.live, network: network ?? "all", statsBuiltAt: meta.statsBuiltAt },
    body,
    scripts: ["/static/app.js"],
  });
}

export function methodologyPage(): string {
  const body = html`
<article class="prose">
<h1>Methodology</h1>
<p><strong>This is not an official Flop ranking.</strong> It lists observed, verified receipts that agents submitted after buying inference directly from miners with their own wallets.</p>

<h2>What counts</h2>
<p>A receipt is <em>stored</em> when the submitter is signed in with a DID, <code>payload.did</code> matches that session, and the receipt carries a valid Ed25519 signature over its RFC 8785 (JCS) canonical bytes. It is <em>counted</em> only when all of these also hold:</p>
<ul>
<li><strong>On-chain check passed.</strong> The settlement extrinsic or channel it references exists on the public Flop RPC and agrees with the receipt. Until then it is <code>pending_verification</code> and hidden from rankings. If the RPC is down, nothing counts; verification is retried from a queue and a daily job.</li>
<li><strong>No self-dealing.</strong> Receipts where buyer = miner never count. Nor do receipts where the submitter's DID is bound to the miner wallet, or where buyer and miner are bound to the same DID. Excluded receipts stay visible on the miner page with the reason.</li>
<li><strong>Not a duplicate.</strong> Each receipt nonce, and each settlement extrinsic per network, counts once.</li>
</ul>
<p>Gateway-broker purchases (<code>api.flop.network</code>) are not part of this table: they spend broker funds and often hide the miner.</p>
<p>Failed and timed-out attempts count too. They are the reliability signal.</p>

<h2>Metrics</h2>
<ul>
<li><strong>Success rate</strong>: receipts with <code>ok = true</code> and status <code>settled</code>, divided by all counted receipts whose status is not <code>pending</code>.</li>
<li><strong>Settlement rate</strong>: <code>settled</code> ÷ (<code>settled</code> + <code>challenged</code> + <code>failed</code> with error class <code>settlement</code> + <code>timeout</code> after a channel was opened).</li>
<li><strong>Latency p50 / p95</strong>: nearest-rank percentiles of <code>latencyMs</code>, including failed calls that reported one.</li>
<li><strong>FLOP / session</strong>: median actual <code>paidFlop</code> on settled receipts. The <code>maxFlop</code> cap is never used as a price. If the chain or SDK doesn't expose the paid amount, this shows "n/a".</li>
<li><strong>FLOP / token</strong>: median <code>paidFlop ÷ (promptTokens + completionTokens)</code> where both exist.</li>
<li><strong>Last seen</strong>: latest <code>finishedAt</code> (or <code>startedAt</code>).</li>
<li><strong>n</strong>: the number of counted receipts in the window. Rows with <em>n</em> under 5 are marked <span class="warn">low n</span>.</li>
</ul>
<p>Windows: 7 days, 30 days and all time, by <code>startedAt</code>. Aggregates update when each receipt lands and are rebuilt every day. Nobody edits them by hand.</p>

<h2>Signatures and sign-in</h2>
<p>Any Ed25519 <code>did:key</code> may connect. The server issues a one-time challenge tied to this site's domain, valid for five minutes. You sign its JCS bytes and get a short-lived session. Each receipt is still signed separately, so a leaked session token cannot produce receipts that anyone can verify independently.</p>

<h2>Abuse controls</h2>
<p>Each DID and each IP gets 30 submissions an hour and 200 per UTC day. Over the limit, the API returns HTTP 429.</p>

<h2>Privacy</h2>
<p>Only hashes are stored for prompts, outputs and miner URLs. Public pages and JSON feeds never show buyer wallets or submitter DIDs.</p>

<h2>Sample data</h2>
<p>Until a real counted testnet receipt exists, the board shows clearly labelled sample rows under a <strong>SAMPLE — NOT LIVE DATA</strong> banner.</p>

<h2>Machine-readable</h2>
<ul><li><a href="/feeds/miners.json">/feeds/miners.json</a> — all miners, all windows</li>
<li><code>/feeds/miners/&lt;ss58&gt;.json</code> — one miner, with its receipt index</li>
<li><a href="/feeds/meta.json">/feeds/meta.json</a> — data label, counts, build time</li>
<li><code>/data/*</code> — daily snapshots from R2</li></ul>
</article>`;
  return layout({ title: "Methodology — Flop Miner Board", body, active: "/methodology" });
}

export function connectPage(): string {
  const body = html`
<article class="prose">
<h1>Connect with a DID</h1>
<p>Signing in works like connecting a wallet to a DeFi app. You sign a one-time challenge with your Ed25519 <code>did:key</code>. Your private key never leaves your machine. <strong>Agents should use the API, not this form</strong>. See <code>scripts/agent-cli.ts</code>.</p>
<noscript><p class="warn">This page needs JavaScript to call the API. Agents can use the HTTP endpoints directly.</p></noscript>

<section class="card connected" id="connected" hidden>
<p class="connected-as" role="status">Connected as <span id="connected-did" class="mono"></span></p>
<button type="button" id="logout" class="secondary">Disconnect</button>
</section>

<section class="card" id="step1">
<h2>1. Get a challenge</h2>
<button type="button" id="get-challenge">Request challenge</button>
<label for="challenge">Challenge (sign these exact bytes; they're already JCS-canonical)</label>
<textarea id="challenge" rows="6" readonly spellcheck="false"></textarea>
<p class="hint">No DID browser extension? Sign it on the command line:</p>
<pre><code id="cli">FLOP_DID_PRIVATE_KEY=… npx tsx scripts/agent-cli.ts sign-challenge &lt; challenge.json</code></pre>
</section>

<section class="card" id="step2">
<h2>2. Paste your DID and signature</h2>
<label for="did">DID</label><input id="did" type="text" placeholder="did:key:z6Mk…" spellcheck="false" autocomplete="off">
<label for="signature">Signature (base64url)</label><input id="signature" type="text" spellcheck="false" autocomplete="off">
<button type="button" id="verify">Connect</button>
<p id="session-status" class="status" role="status">Not connected.</p>
</section>

<section class="card" id="step3">
<h2><span id="step3-num">3. </span>Submit a signed receipt</h2>
<label for="envelope">Envelope JSON <code>{ "payload": {…}, "signature": "…" }</code></label>
<textarea id="envelope" rows="10" spellcheck="false" disabled></textarea>
<label for="envelope-file">…or upload a file</label><input id="envelope-file" type="file" accept="application/json,.json" disabled>
<button type="button" id="submit" disabled>Submit receipt</button>
<pre id="submit-result" class="result" role="status"></pre>
</section>
</article>`;
  return layout({ title: "Connect — Flop Miner Board", body, scripts: ["/static/app.js", "/static/connect.js"], active: "/connect" });
}

export function notFoundPage(): string {
  return layout({ title: "Not found — Flop Miner Board", body: html`<h1>Not found</h1><p><a href="/">Back to the board</a></p>` });
}

export { esc };
