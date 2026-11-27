/**
 * Inserts SAMPLE — NOT LIVE DATA rows (is_sample = 1) so the board has something to render.
 * They are hidden automatically once a real counted testnet receipt exists.
 *
 *   npm run seed               # local D1 (wrangler dev)
 *   npm run seed -- --remote   # production D1 (asks wrangler for confirmation)
 *   npm run seed -- --clear    # remove sample rows
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ss58Encode } from "../src/did/ss58";

const args = new Set(process.argv.slice(2));
const target = args.has("--remote") ? "--remote" : "--local";

let state = 0x9e3779b9;
const rand = () => {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 2 ** 32;
};
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 256).toString(16).padStart(2, "0")).join("");
const addr = () => ss58Encode(Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256)));
const q = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const models = ["sample-llama-8b", "sample-qwen-14b"];
const miners = Array.from({ length: 7 }, (_, i) => ({
  addr: addr(),
  model: models[i % 2]!,
  reliability: [0.97, 0.9, 0.82, 0.7, 0.95, 0.55, 0.88][i]!,
  baseLatency: [600, 900, 1400, 2200, 750, 3000, 1100][i]!,
  price: [0.004, 0.003, 0.0025, 0.002, 0.005, 0.0015, 0.0035][i]!,
  volume: [30, 22, 18, 12, 9, 6, 3][i]!,
}));

const rows: string[] = [];
const now = Date.now();
for (const m of miners) {
  for (let k = 0; k < m.volume; k++) {
    const started = new Date(now - rand() * 28 * 86_400_000);
    const r = rand();
    const ok = r < m.reliability;
    const status = ok ? "settled" : r < m.reliability + (1 - m.reliability) / 2 ? "failed" : "timeout";
    const latency = ok || status === "failed" ? Math.round(m.baseLatency * (0.6 + rand() * 1.2)) : 30000;
    const finished = new Date(started.getTime() + latency);
    const pt = 30 + Math.floor(rand() * 60);
    const ct = 100 + Math.floor(rand() * 300);
    const paid = ok ? (m.price * (0.8 + rand() * 0.4)).toFixed(6) : null;
    const id = `sample-${hex(16)}`;
    // Mandatory buyer rating (1–5, 0.5 steps), loosely tracking the miner's reliability.
    const rating = Math.min(5, Math.max(1, Math.round((ok ? 3 + m.reliability * 2 * rand() + 0.4 : 1 + rand() * 1.5) * 2) / 2));
    rows.push(
      `(${[
        id, "testnet", "did:key:SAMPLE-NOT-LIVE", addr(), m.addr, m.model, `ch-sample-${hex(4)}`,
        ok ? `0x${hex(32)}` : null, ok ? 100000 + Math.floor(rand() * 50000) : null, status, ok ? 1 : 0, "0.01", paid,
        ok ? pt : null, ok ? ct : null, latency, ok ? null : status === "timeout" ? "timeout" : "miner-unreachable",
        started.toISOString(), finished.toISOString(), finished.toISOString(), hex(16), "{}", "SAMPLE", now,
        "passed", "sample", "SAMPLE — NOT LIVE DATA", 1, 1, rating,
      ].map(q).join(", ")})`,
    );
  }
}

const cols = `id, network, did, buyer, miner, model, channel_id, settlement_tx, block_number, status, ok, max_flop, paid_flop,
  prompt_tokens, completion_tokens, latency_ms, error_class, started_at, finished_at, submitted_at, nonce, payload_json,
  signature, received_at, verification, verified_by, verification_note, counted, is_sample, rating`;

const sql = args.has("--clear")
  ? "DELETE FROM receipts WHERE is_sample = 1;\nINSERT OR REPLACE INTO meta (key, value) VALUES ('stats_dirty', '1');\n"
  : [
      "DELETE FROM receipts WHERE is_sample = 1;",
      ...rows.map((r) => `INSERT INTO receipts (${cols}) VALUES ${r};`),
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('stats_dirty', '1');",
    ].join("\n");

const dir = mkdtempSync(join(tmpdir(), "flop-seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, sql);
console.log(`${args.has("--clear") ? "Clearing" : `Seeding ${rows.length}`} SAMPLE rows (${target})…`);
execFileSync("npx", ["wrangler", "d1", "execute", "flop-board", target, `--file=${file}`], { stdio: "inherit" });
