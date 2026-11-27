import { describe, expect, it } from "vitest";
import { SUBMIT_JS } from "../src/pages/static";
import { call, envelope, makePayload, newKey } from "./helpers";

type Described = { ok: boolean; error: string | null; fields: [string, string][]; rating: number | null; notes: string | null };

/** Run the shipped submit.js with no form on the page: it only defines window.flopDescribeEnvelope. */
function loadDescribe(): (text: string) => Described {
  const win: Record<string, unknown> = {};
  new Function("window", "document", SUBMIT_JS)(win, { getElementById: () => null });
  return win.flopDescribeEnvelope as (text: string) => Described;
}

describe("envelope preview (submit form)", () => {
  const describeEnvelope = loadDescribe();
  const key = newKey();

  it("shows the rating, notes and session facts of a signed envelope", () => {
    const env = envelope(key, makePayload(key.did, { review: { rating: 4.5, notes: "  Correct, a bit slow " } }));
    const d = describeEnvelope(JSON.stringify(env));
    expect(d).toMatchObject({ ok: true, error: null, rating: 4.5, notes: "Correct, a bit slow" });
    const fields = Object.fromEntries(d.fields);
    expect(fields).toMatchObject({ Network: "testnet", Model: "llama-3.1-8b-instruct", Session: "settled · delivered", Paid: "0.004 FLOP" });
    expect(fields.Miner).toMatch(/…/);
  });

  it.each([
    ["", null],
    ["{not json", "Not valid JSON"],
    ["[]", "Expected an object"],
    [JSON.stringify({ signature: "x" }), "Missing \"payload\""],
    [JSON.stringify({ payload: { kind: "flop.miner-receipt" } }), "Missing \"signature\""],
    [JSON.stringify({ payload: { kind: "flop.miner-review" }, signature: "x" }), "flop.miner-receipt"],
  ])("explains a bad paste: %s", (text, err) => {
    const d = describeEnvelope(text);
    expect(d.ok).toBe(false);
    if (err === null) expect(d.error).toBeNull();
    else expect(d.error).toContain(err);
  });

  it("refuses a missing or off-scale rating, before anything is sent", () => {
    const noReview = makePayload(key.did) as Record<string, unknown>;
    delete noReview.review;
    expect(describeEnvelope(JSON.stringify(envelope(key, noReview))).error).toMatch(/No rating in this receipt/);
    for (const rating of [4.25, 0, 5.5, "4"]) {
      const d = describeEnvelope(JSON.stringify(envelope(key, makePayload(key.did, { review: { rating } }))));
      expect(d.ok, String(rating)).toBe(false);
      expect(d.error).toMatch(/half steps/);
    }
    expect(describeEnvelope(JSON.stringify(envelope(key, makePayload(key.did, { review: { rating: 3, notes: "x".repeat(501) } })))).error).toMatch(/500/);
  });

  it("the board form has the preview area and explains where the rating lives", async () => {
    const r = await call("/?t=preview");
    expect(r.text).toContain('id="envelope-preview"');
    expect(r.text).toContain("payload.review.rating");
  });

  it("pasting and previewing work before connecting; only Submit starts disabled", async () => {
    const r = await call("/?t=preview2");
    expect(r.text).toContain('<textarea id="envelope" rows="10" spellcheck="false"></textarea>');
    expect(r.text).toMatch(/<input id="envelope-file" type="file" accept="application\/json,\.json">/);
    expect(r.text).toContain('<button type="button" id="submit" disabled>');
    expect(SUBMIT_JS).toContain("$('submit').disabled = !(connected && valid)");
    expect(SUBMIT_JS).not.toContain("$(id).disabled = !connected");
  });
});
