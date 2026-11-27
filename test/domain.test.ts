import { describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/index";
import { call } from "./helpers";

async function fetchWith(url: string, init: RequestInit, over: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, init), { ...env, ...over }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("canonical domain", () => {
  const canon = { CANONICAL_ORIGIN: "https://flopminer.watch" };

  it("redirects other hosts to the canonical origin, keeping path and query", async () => {
    const r = await fetchWith("https://flopwatch.ricfmartins.workers.dev/miner/5Abc?network=testnet", {}, canon);
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://flopminer.watch/miner/5Abc?network=testnet");
    const www = await fetchWith("https://www.flopminer.watch/reviews", {}, canon);
    expect(www.headers.get("location")).toBe("https://flopminer.watch/reviews");
  });

  it("uses 308 for API writes so POST bodies survive", async () => {
    const r = await fetchWith("https://flopwatch.ricfmartins.workers.dev/v1/receipts", { method: "POST", body: "{}" }, canon);
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://flopminer.watch/v1/receipts");
  });

  it("serves normally on the canonical host, and everywhere when unset", async () => {
    expect((await fetchWith("https://flopminer.watch/healthz", {}, canon)).status).toBe(200);
    expect((await fetchWith("https://anything.example/healthz", {}, { CANONICAL_ORIGIN: "" })).status).toBe(200);
  });
});

describe("footer", () => {
  it("explains the shrunk rating in fine print and has no source link", async () => {
    const r = await call("/methodology");
    expect(r.text).toContain('class="footer-fine"');
    expect(r.text).toContain("A single 2.5 ★ shows as 2.92 ★");
    expect(r.text).not.toContain("github.com");
    expect(r.text).not.toContain("Source ↗");
  });
});
