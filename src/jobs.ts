import type { Env, VerifyJob } from "./env";
import { intVar } from "./env";
import { runVerification } from "./receipts/process";
import type { ReceiptPayload } from "./receipts/schema";
import { getVerifier } from "./verify";
import { recomputeAll } from "./stats/aggregate";
import { writeSnapshot } from "./stats/feeds";
import { pruneChallenges } from "./auth/challenge";
import { pruneRateLimits } from "./lib/ratelimit";

/** Queue consumer: on-chain verification retries with exponential backoff. Ratings ride along with receipts. */
export async function handleVerifyBatch(batch: MessageBatch<VerifyJob>, env: Env): Promise<void> {
  const maxAttempts = intVar(env.VERIFY_MAX_ATTEMPTS, 12);
  for (const msg of batch.messages) {
    const id = msg.body.receiptId;
    if (!id) {
      msg.ack(); // e.g. a leftover message from the short-lived standalone reviews queue
      continue;
    }
    const row = await env.DB.prepare("SELECT payload_json, excluded_reason, verification, verify_attempts FROM receipts WHERE id = ?")
      .bind(id)
      .first<{ payload_json: string; excluded_reason: string | null; verification: string; verify_attempts: number }>();
    if (!row || row.verification !== "pending_verification") {
      msg.ack();
      continue;
    }
    if (row.verify_attempts >= maxAttempts) {
      await giveUp(env, id);
      msg.ack();
      continue;
    }
    try {
      const state = await runVerification(env, id, JSON.parse(row.payload_json) as ReceiptPayload, row.excluded_reason, "queue");
      if (state.verification === "pending_verification") msg.retry({ delaySeconds: Math.min(60 * 2 ** msg.attempts, 6 * 3600) });
      else msg.ack();
    } catch {
      msg.retry({ delaySeconds: Math.min(60 * 2 ** msg.attempts, 6 * 3600) });
    }
  }
}

async function giveUp(env: Env, id: string) {
  await env.DB.prepare(
    "UPDATE receipts SET verification = 'failed', verification_note = 'verification_gave_up', verified_at = ? WHERE id = ? AND verification = 'pending_verification'",
  )
    .bind(Date.now(), id)
    .run();
}

export const DAILY_CRON = "17 3 * * *";

/**
 * Frequent cron: queue receipts that were never checked against a chain because that network's RPC
 * was not configured when they arrived. Once an RPC URL is set they get verified within minutes,
 * not at the next daily run. Real RPC outages keep the queue's own backoff + the daily sweep.
 */
export async function requeueUnconfigured(env: Env): Promise<number> {
  const verifier = getVerifier(env);
  const { results } = await env.DB.prepare(
    `SELECT id, network FROM receipts
      WHERE verification = 'pending_verification' AND verification_note LIKE 'rpc_not_configured:%'
      ORDER BY received_at LIMIT 500`,
  ).all<{ id: string; network: "testnet" | "devnet" }>();
  const jobs = results.filter((r) => verifier.canVerify(r.network)).map((r) => ({ body: { receiptId: r.id } }));
  if (jobs.length === 0) return 0;
  // Mark as queued so the next 15-minute tick doesn't enqueue the same rows again.
  await env.DB.batch(
    jobs.map((j) =>
      env.DB.prepare("UPDATE receipts SET verification_note = 'queued_for_verification' WHERE id = ? AND verification = 'pending_verification'").bind(j.body.receiptId),
    ),
  );
  for (let i = 0; i < jobs.length; i += 100) await env.VERIFY_QUEUE.sendBatch(jobs.slice(i, i + 100));
  return jobs.length;
}

/** Daily cron: re-queue stale pending rows (Free queue retention is 24 h), rebuild, snapshot, prune. */
export async function handleCron(env: Env): Promise<void> {
  const verifier = getVerifier(env);
  const maxAttempts = intVar(env.VERIFY_MAX_ATTEMPTS, 12);
  const { results } = await env.DB.prepare(
    `SELECT id, network, verify_attempts FROM receipts
      WHERE verification = 'pending_verification' AND received_at < ? ORDER BY received_at LIMIT 1000`,
  )
    .bind(Date.now() - 3600_000)
    .all<{ id: string; network: "testnet" | "devnet"; verify_attempts: number }>();
  const jobs: { body: VerifyJob }[] = [];
  for (const r of results) {
    if (r.verify_attempts >= maxAttempts) await giveUp(env, r.id);
    else if (verifier.canVerify(r.network)) jobs.push({ body: { receiptId: r.id } });
  }
  for (let i = 0; i < jobs.length; i += 100) await env.VERIFY_QUEUE.sendBatch(jobs.slice(i, i + 100));
  await recomputeAll(env); // receipts and buyer ratings
  await writeSnapshot(env);
  await pruneChallenges(env);
  await pruneRateLimits(env);
}
