import type { Env, Network } from "../env";
import { explorerLink, intVar, networkConfig } from "../env";
import { buildMeta } from "../stats/feeds";
import { WINDOWS, type StatsWindow } from "../stats/aggregate";
import { minerReviews, reviewStatsRows, type ReviewStatsRow } from "../reviews/feeds";
import { html, lisbon, ms, pct, raw, short, type Raw } from "./html";
import { layout } from "./layout";

const score = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(2));
const flopv = (x: number | null | undefined) => (x == null ? "n/a" : String(+x.toPrecision(6)));

function minerCell(env: Env, network: string, a: string): Raw {
  const link = explorerLink(networkConfig(env, network as Network).accountUrl, "address", a);
  return html`<span class="addr"><a href="/miner/${encodeURIComponent(a)}?network=${network}" title="${a}">${short(a)}</a><button type="button" class="copy" data-copy="${a}" aria-label="Copy address">⧉</button>${
    link ? html`<a class="ext" href="${link}" rel="noopener" target="_blank" aria-label="FLOPScan account (official)" title="FLOPScan account (official)">↗</a>` : ""
  }</span>`;
}

/** Links to the official chain-side surfaces. Never re-hosts FLOPScan data. */
export function flopscanLinks(env: Env, network: string, miner: string): Raw {
  const net = networkConfig(env, network as Network);
  const account = explorerLink(net.accountUrl, "address", miner);
  const reliability = net.minerReliabilityUrl ? explorerLink(net.minerReliabilityUrl, "address", miner) : net.marketsUrl || null;
  if (!account && !reliability) return html``;
  return html`<p class="official-links">Official, chain-side:
    ${account ? html`<a href="${account}" rel="noopener" target="_blank">FLOPScan account ↗</a>` : ""}
    ${reliability ? html`<a href="${reliability}" rel="noopener" target="_blank">FLOPScan reliability (markets) ↗</a>` : ""}</p>`;
}

const SORTS: Record<string, keyof ReviewStatsRow> = {
  miner: "miner", model: "model", n: "n", score: "buyer_score", quality: "quality_avg", latency: "latency_avg",
  cost: "cost_avg", delivery: "delivery_avg", rate: "delivery_rate", useful: "paid_flop_per_useful_median", last: "last_reviewed_at",
};
const NUMERIC = new Set(["n", "score", "quality", "latency", "cost", "delivery", "rate", "useful"]);

/** Reviews leaderboard: /reviews and /?view=reviews (FLOPWATCH-BUYER-REVIEWS-SPEC §9.2). Works with JS off. */
export async function reviewsPage(env: Env, q: URLSearchParams): Promise<string> {
  const meta = await buildMeta(env);
  const network = q.get("network") === "devnet" ? "devnet" : "testnet";
  const win = (WINDOWS as readonly string[]).includes(q.get("window") ?? "") ? (q.get("window") as StatsWindow) : "all";
  const model = q.get("model") ?? "";
  const defaultMinN = intVar(env.REVIEW_MIN_N, 5);
  const minN = Math.max(defaultMinN, Number.parseInt(q.get("minN") ?? String(defaultMinN), 10) || defaultMinN);
  const sortKey = SORTS[q.get("sort") ?? ""] ? (q.get("sort") as string) : "score";
  const dir = q.get("dir") === "asc" ? "asc" : "desc";

  const all = await reviewStatsRows(env, { network, window: win });
  const models = [...new Set(all.map((r) => r.model))].sort();
  const inModel = all.filter((r) => !model || r.model === model);
  const col = SORTS[sortKey]!;
  const ranked = inModel
    .filter((r) => r.n >= minN)
    .sort((a, b) => {
      const x = a[col], y = b[col];
      if (x === y) return b.n - a.n;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = x < y ? -1 : 1;
      return dir === "asc" ? c : -c;
    });
  const tooFew = inModel.filter((r) => r.n < minN);

  const th = (key: string, label: string) => {
    const p = new URLSearchParams(q);
    p.set("sort", key);
    p.set("dir", sortKey === key && dir === "desc" ? "asc" : "desc");
    const arrow = sortKey === key ? (dir === "desc" ? " ▾" : " ▴") : "";
    return html`<th scope="col"${NUMERIC.has(key) ? raw(' class="num"') : ""} aria-sort="${sortKey === key ? (dir === "desc" ? "descending" : "ascending") : "none"}"><a href="?${p.toString()}">${label}${arrow}</a></th>`;
  };
  const markets = networkConfig(env, network).marketsUrl;

  const body = html`
<section class="intro">
  <p class="eyebrow">Buyer reviews · ${network}</p>
  <h1>What miners actually delivered.</h1>
  <p class="lead">Structured opinions from buyers whose paid sessions were verified on chain: answer quality, responsiveness, value for the FLOP paid, and whether the answer was delivered. Observed buyer feedback, not an official FLOP ranking.
  ${markets ? html`For official chain-side reliability, see <a href="${markets}" rel="noopener" target="_blank">FLOPScan markets ↗</a>.` : ""}</p>
  <p class="view-switch"><a href="/?network=${network}">Receipts</a> · <strong>Buyer reviews</strong></p>
</section>
<details class="submit-panel" id="submit-panel">
  <summary>Submit a signed review</summary>
  <section class="card" id="review-submit">
    <p id="submit-auth-note" class="hint">You need to <a href="/connect">connect your DID</a> before submitting. Agents should use <code>agent-cli submit-review</code>.</p>
    <label for="envelope">Envelope JSON <code>{ "payload": {…}, "signature": "…", "walletSignature"?: "…" }</code></label>
    <textarea id="envelope" rows="10" spellcheck="false" disabled></textarea>
    <label for="envelope-file">…or upload a file</label><input id="envelope-file" type="file" accept="application/json,.json" disabled>
    <button type="button" id="submit" data-endpoint="/v1/reviews" disabled>Submit review</button>
    <pre id="submit-result" class="result" role="status"></pre>
  </section>
</details>
<form class="filters" method="get" action="/reviews">
  <label>Network <select name="network">
    <option value="testnet"${network === "testnet" ? raw(" selected") : ""}>testnet</option>
    <option value="devnet"${network === "devnet" ? raw(" selected") : ""}>devnet</option></select></label>
  <label>Window <select name="window">${WINDOWS.map((w) => html`<option value="${w}"${w === win ? raw(" selected") : ""}>${w}</option>`)}</select></label>
  <label>Model <select name="model"><option value="">all models</option>${models.map((m) => html`<option value="${m}"${m === model ? raw(" selected") : ""}>${m}</option>`)}</select></label>
  <label>Min n <input type="number" name="minN" min="${defaultMinN}" value="${minN}" inputmode="numeric"></label>
  <input type="hidden" name="sort" value="${sortKey}"><input type="hidden" name="dir" value="${dir}">
  <button type="submit">Apply</button>
</form>
<div class="table-wrap">
<table class="board">
  <thead><tr>
    ${th("miner", "Miner")}${th("model", "Model")}${th("n", "n")}${th("score", "Buyer score")}${th("quality", "Quality")}${th("latency", "Latency")}
    ${th("cost", "Cost")}${th("delivery", "Delivery")}${th("rate", "Delivered")}${th("useful", "FLOP / useful")}${th("last", "Last reviewed")}
  </tr></thead>
  <tbody>
  ${
    ranked.length
      ? ranked.map(
          (r) => html`<tr>
    <td data-label="Miner">${minerCell(env, r.network, r.miner)}</td>
    <td data-label="Model"><code>${r.model}</code></td>
    <td data-label="n" class="num">${r.n}${r.buyer_concentration === "high" ? html` <span class="warn" title="One buyer wrote over 30% of these reviews">1 buyer &gt;30%</span>` : ""}</td>
    <td data-label="Buyer score" class="num"><strong>${score(r.buyer_score)}</strong></td>
    <td data-label="Quality" class="num">${score(r.quality_avg)}</td>
    <td data-label="Latency" class="num">${score(r.latency_avg)}</td>
    <td data-label="Cost" class="num">${score(r.cost_avg)}</td>
    <td data-label="Delivery" class="num">${score(r.delivery_avg)}</td>
    <td data-label="Delivered" class="num">${pct(r.delivery_rate)}</td>
    <td data-label="FLOP / useful" class="num">${flopv(r.paid_flop_per_useful_median)}</td>
    <td data-label="Last reviewed">${lisbon(r.last_reviewed_at)}</td>
  </tr>`,
        )
      : html`<tr><td colspan="11" class="empty">No miner has ${minN}+ counted reviews in this view yet.</td></tr>`
  }
  </tbody>
</table>
</div>
${
  tooFew.length
    ? html`<p class="hint">Too few reviews to rank (n &lt; ${minN}): ${tooFew.map(
        (r, i) => html`${i ? ", " : ""}<a href="/miner/${encodeURIComponent(r.miner)}?network=${r.network}">${short(r.miner)}</a> (${r.model}, n=${r.n})`,
      )}.</p>`
    : ""
}
<p class="hint">Scores are 1–5, shrunk toward 3.0 so a handful of reviews can't dominate. Buyer score = 0.4·quality + 0.2·latency + 0.2·cost + 0.2·delivery. Only miners with ${minN}+ counted reviews are ranked. <a href="/methodology#reviews">How reviews count</a>.</p>`;

  return layout({
    title: "Buyer reviews — Flopwatch",
    banner: { label: meta.dataLabel, live: meta.live, network, statsBuiltAt: meta.statsBuiltAt },
    body,
    scripts: ["/static/submit.js"],
    active: "/reviews",
  });
}

/** "Buyer reviews" block on /miner/:ss58 (§9.1), shown next to the receipt stats, never instead of them. */
export async function minerReviewsSection(env: Env, miner: string, network: string): Promise<Raw> {
  const data = await minerReviews(env, miner, network, 10);
  const byModel = new Map<string, typeof data.stats>();
  for (const s of data.stats) byModel.set(s.model, [...(byModel.get(s.model) ?? []), s]);
  return html`<section id="reviews">
<h2>Buyer reviews</h2>
<p class="hint">Buyer-side feedback from verified paid sessions. FLOPScan is the official chain-side reliability surface.</p>
${flopscanLinks(env, network, miner)}
${
  byModel.size === 0
    ? html`<p class="empty-note">No counted reviews yet.</p>`
    : [...byModel.entries()].map(
        ([model, stats]) => html`<h3 class="mono">${model}</h3>
<div class="table-wrap"><table class="board compact"><thead><tr><th>Window</th><th class="num">n</th><th class="num">Buyer score</th><th class="num">Quality</th><th class="num">Latency</th><th class="num">Cost</th><th class="num">Delivery</th><th class="num">Delivered</th><th class="num">FLOP / useful</th><th>Last reviewed</th></tr></thead>
<tbody>${WINDOWS.map((w) => {
          const s = stats.find((x) => x.window === w);
          return s
            ? html`<tr><td data-label="Window">${w}</td><td data-label="n" class="num">${s.n}${s.lowSample ? html` <span class="warn">low n</span>` : ""}</td><td data-label="Buyer score" class="num">${score(s.buyerScore)}</td><td data-label="Quality" class="num">${score(s.qualityAvg)}</td><td data-label="Latency" class="num">${score(s.latencyAvg)}</td><td data-label="Cost" class="num">${score(s.costAvg)}</td><td data-label="Delivery" class="num">${score(s.deliveryAvg)}</td><td data-label="Delivered" class="num">${pct(s.deliveryRate)}</td><td data-label="FLOP / useful" class="num">${flopv(s.paidFlopPerUsefulMedian)}</td><td data-label="Last reviewed">${lisbon(s.lastReviewedAt)}</td></tr>`
            : html`<tr><td data-label="Window">${w}</td><td colspan="9" class="empty">no counted reviews</td></tr>`;
        })}</tbody></table></div>`,
      )
}
${
  data.latest.length
    ? html`<h3>Latest reviews</h3>
<div class="table-wrap"><table class="board compact"><thead><tr><th>Submitted</th><th>Model</th><th class="num">Q / L / C / D</th><th>Delivered</th><th>Category</th><th class="num">Latency</th><th>Notes</th></tr></thead>
<tbody>${data.latest.map((r) => {
        const sc = r.scores;
        const f = (v: number | null | undefined) => (v == null ? "–" : String(v));
        return html`<tr><td data-label="Submitted">${lisbon(r.submittedAt as string)}</td><td data-label="Model"><code>${r.model}</code></td><td data-label="Q / L / C / D" class="num">${sc ? `${f(sc.quality)} / ${f(sc.latency)} / ${f(sc.cost)} / ${f(sc.delivery)}` : "—"}</td><td data-label="Delivered"><span class="pill ${r.delivered ? "ok" : "bad"}">${r.delivered ? "yes" : "no"}</span></td><td data-label="Category">${r.promptCategory ?? "—"}</td><td data-label="Latency" class="num">${ms(r.latencyMs as number | null)}</td><td data-label="Notes" class="notes">${r.notes ?? ""}</td></tr>`;
      })}</tbody></table></div>`
    : ""
}
</section>`;
}
