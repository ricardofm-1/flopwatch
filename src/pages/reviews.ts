import type { Env, Network } from "../env";
import { explorerLink, intVar, networkConfig } from "../env";
import { buildMeta, type publicReceipt } from "../stats/feeds";
import { WINDOWS, type StatsWindow } from "../stats/aggregate";
import { reviewStatsRows, type ReviewStatsRow } from "../reviews/feeds";
import { html, lisbon, pct, raw, short, type Raw } from "./html";
import { layout } from "./layout";

/** "4.33 ★" for an average, "4.5 ★" for a single rating, "—" when none. */
export const stars = (x: number | null | undefined, digits = 2) =>
  x == null ? "—" : `${Number.isInteger(x) ? x.toFixed(0) : x.toFixed(digits).replace(/0$/, "")} ★`;
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
  miner: "miner", model: "model", n: "n", rating: "rating_avg", median: "rating_median", rate: "delivery_rate",
  useful: "paid_flop_per_useful_median", last: "last_reviewed_at",
};
const NUMERIC = new Set(["n", "rating", "median", "rate", "useful"]);

/** Ratings leaderboard: /reviews and /?view=reviews. Server-rendered, works with JS off. */
export async function reviewsPage(env: Env, q: URLSearchParams): Promise<string> {
  const meta = await buildMeta(env);
  const network = q.get("network") === "devnet" ? "devnet" : "testnet";
  const win = (WINDOWS as readonly string[]).includes(q.get("window") ?? "") ? (q.get("window") as StatsWindow) : "all";
  const model = q.get("model") ?? "";
  const defaultMinN = intVar(env.REVIEW_MIN_N, 5);
  const minN = Math.max(defaultMinN, Number.parseInt(q.get("minN") ?? String(defaultMinN), 10) || defaultMinN);
  const sortKey = SORTS[q.get("sort") ?? ""] ? (q.get("sort") as string) : "rating";
  const dir = q.get("dir") === "asc" ? "asc" : "desc";

  const all = await reviewStatsRows(env, { network, window: win, hideSamples: meta.live });
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
  <p class="eyebrow">Buyer ratings · ${network}</p>
  <h1>What miners actually delivered.</h1>
  <p class="lead">Every receipt carries the buyer's 1–5 star rating of the session. Ratings count only when the paid session was verified on chain. This is observed buyer feedback, not an official FLOP ranking.
  ${markets ? html`For official chain-side reliability, see <a href="${markets}" rel="noopener" target="_blank">FLOPScan markets ↗</a>.` : ""}</p>
  <p class="view-switch"><a href="/?network=${network}">Receipts</a> · <strong>Buyer ratings</strong></p>
</section>
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
    ${th("miner", "Miner")}${th("model", "Model")}${th("n", "n")}${th("rating", "Rating")}${th("median", "Median")}
    ${th("rate", "Delivered")}${th("useful", "FLOP / useful")}${th("last", "Last rated")}
  </tr></thead>
  <tbody>
  ${
    ranked.length
      ? ranked.map(
          (r) => html`<tr>
    <td data-label="Miner">${minerCell(env, r.network, r.miner)}</td>
    <td data-label="Model"><code>${r.model}</code></td>
    <td data-label="n" class="num">${r.n}${r.buyer_concentration === "high" ? html` <span class="warn" title="One buyer gave over 30% of these ratings">1 buyer &gt;30%</span>` : ""}</td>
    <td data-label="Rating" class="num stars"><strong>${stars(r.rating_avg)}</strong></td>
    <td data-label="Median" class="num">${stars(r.rating_median, 1)}</td>
    <td data-label="Delivered" class="num">${pct(r.delivery_rate)}</td>
    <td data-label="FLOP / useful" class="num">${flopv(r.paid_flop_per_useful_median)}</td>
    <td data-label="Last rated">${lisbon(r.last_reviewed_at)}</td>
  </tr>`,
        )
      : html`<tr><td colspan="8" class="empty">No miner has ${minN}+ counted ratings in this view yet.</td></tr>`
  }
  </tbody>
</table>
</div>
${
  tooFew.length
    ? html`<p class="hint">Too few ratings to rank (n &lt; ${minN}): ${tooFew.map(
        (r, i) => html`${i ? ", " : ""}<a href="/miner/${encodeURIComponent(r.miner)}?network=${r.network}">${short(r.miner)}</a> (${r.model}, n=${r.n})`,
      )}.</p>`
    : ""
}
<p class="hint">Ratings are shrunk toward 3.0 so a handful can't dominate: (5 × 3.0 + Σ ratings) ÷ (5 + n). Only miners with ${minN}+ counted ratings are ranked. <a href="/methodology#reviews">How ratings count</a>.</p>`;

  return layout({
    title: "Buyer ratings — Flopwatch",
    banner: { label: meta.dataLabel, live: meta.live, network, statsBuiltAt: meta.statsBuiltAt },
    body,
    active: "/reviews",
  });
}

type PublicReceipt = ReturnType<typeof publicReceipt>;

/** "Buyer ratings" block on /miner/:ss58: aggregates per model + the latest rated receipts with notes. */
export async function minerReviewsSection(env: Env, miner: string, network: string, hideSamples: boolean, receipts: PublicReceipt[]): Promise<Raw> {
  const stats = await reviewStatsRows(env, { network, miner, hideSamples });
  const byModel = new Map<string, ReviewStatsRow[]>();
  for (const s of stats) byModel.set(s.model, [...(byModel.get(s.model) ?? []), s]);
  const rated = receipts.filter((r) => r.review && r.counted && !r.review.excludedReason).slice(0, 10);
  return html`<section id="reviews">
<h2>Buyer ratings</h2>
<p class="hint">Buyer-side feedback, submitted with each verified paid receipt. FLOPScan is the official chain-side reliability surface.</p>
${
  byModel.size === 0
    ? html`<p class="empty-note">No counted ratings yet.</p>`
    : [...byModel.entries()].map(
        ([model, rows]) => html`<h3 class="mono">${model}</h3>
<div class="table-wrap"><table class="board compact"><thead><tr><th>Window</th><th class="num">n</th><th class="num">Rating</th><th class="num">Median</th><th class="num">Delivered</th><th class="num">FLOP / useful</th><th>Last rated</th></tr></thead>
<tbody>${WINDOWS.map((w) => {
          const s = rows.find((x) => x.window === w);
          return s
            ? html`<tr><td data-label="Window">${w}</td><td data-label="n" class="num">${s.n}${s.n < 5 ? html` <span class="warn">low n</span>` : ""}</td><td data-label="Rating" class="num stars">${stars(s.rating_avg)}</td><td data-label="Median" class="num">${stars(s.rating_median, 1)}</td><td data-label="Delivered" class="num">${pct(s.delivery_rate)}</td><td data-label="FLOP / useful" class="num">${flopv(s.paid_flop_per_useful_median)}</td><td data-label="Last rated">${lisbon(s.last_reviewed_at)}</td></tr>`
            : html`<tr><td data-label="Window">${w}</td><td colspan="6" class="empty">no counted ratings</td></tr>`;
        })}</tbody></table></div>`,
      )
}
${
  rated.length
    ? html`<h3>Latest ratings</h3>
<div class="table-wrap"><table class="board compact"><thead><tr><th>Started</th><th>Model</th><th class="num">Rating</th><th>Session</th><th>Notes</th></tr></thead>
<tbody>${rated.map(
        (r) => html`<tr><td data-label="Started">${lisbon(r.startedAt as string)}</td><td data-label="Model"><code>${r.model}</code></td><td data-label="Rating" class="num stars">${stars(r.review!.rating as number, 1)}</td><td data-label="Session"><span class="pill ${r.ok ? "ok" : "bad"}">${r.status}</span></td><td data-label="Notes" class="notes">${r.review!.notes ?? ""}</td></tr>`,
      )}</tbody></table></div>`
    : ""
}
</section>`;
}
