#!/usr/bin/env node
/**
 * Customer.io email metrics → Attio people, matched by email.
 * Writes cio_sent, cio_opens, cio_clicked, cio_unsubscribe,
 * cio_last_engaged_date, cio_suppression_status.
 * Does not write back to Customer.io.
 *
 * Usage:
 *   LIMIT=20 DRY_RUN=1 node sync-cio-email-metrics.mjs
 *   node sync-cio-email-metrics.mjs
 *
 * Env:
 *   CUSTOMERIO_APP_API_KEY   App API key (Bearer). Tracking API key will not work.
 *   CUSTOMERIO_REGION        us (default) | eu
 *   ATTIO_API_TOKEN
 *   LIMIT                    Max deliveries to scan (empty = all)
 *   LOOKBACK_MONTHS          How far back to walk (default 120). Stops after
 *                            two empty 6-month windows.
 *   DRY_RUN
 *   ATTIO_WRITE_RPS          Attio write cap (default 25/s)
 *   CONCURRENCY              In-flight Attio writes (default 10)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "").trim();
  }
}
loadEnv();

const APP_KEY = process.env.CUSTOMERIO_APP_API_KEY || "";
const ATTIO_TOKEN = process.env.ATTIO_API_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const ATTIO_WRITE_RPS = Math.max(1, Number(process.env.ATTIO_WRITE_RPS || 25));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 10));
const REGION = (process.env.CUSTOMERIO_REGION || "us").toLowerCase();
const BASE =
  REGION === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const LOOKBACK_MONTHS = Math.max(1, Number(process.env.LOOKBACK_MONTHS || 120));
const PAGE_SIZE = 1000;
const WINDOW_SEC = 180 * 24 * 60 * 60;

const COUNTS = ["sent", "opened", "clicked", "unsubscribed"];
const NON_DELIVERY = ["bounced", "failed", "undeliverable", "dropped"];

if (!APP_KEY) {
  console.error(
    "Missing CUSTOMERIO_APP_API_KEY. The Tracking API key (CUSTOMERIO_API_KEY) cannot read metrics. Create an App API key in Customer.io → Settings → API Credentials.",
  );
  process.exit(1);
}
if (!DRY_RUN && !ATTIO_TOKEN) {
  console.error("Missing ATTIO_API_TOKEN (or set DRY_RUN=1)");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cioGet(url, attempt = 0) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${APP_KEY}`,
      Accept: "application/json",
    },
  });
  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get("retry-after") || 2) * 1000;
    await sleep(wait);
    return cioGet(url, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = text.slice(0, 300).replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]");
    throw new Error(`CIO ${res.status} ${url.pathname}${url.search}: ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

function personKey(msg) {
  const ids = msg.customer_identifiers || {};
  const email = (ids.email || "").trim();
  if (email) return email.toLowerCase();
  const recipient = (msg.recipient || "").trim();
  if (recipient.includes("@")) return recipient.toLowerCase();
  return ids.id || ids.cio_id || msg.customer_id || "(inconnu)";
}

function emptyRow() {
  return {
    sent: 0,
    opened: 0,
    clicked: 0,
    unsubscribed: 0,
    bounced: 0,
    failed: 0,
    undeliverable: 0,
    dropped: 0,
    lastEngaged: 0,
    reasons: {},
  };
}

function noteEngaged(row, metrics) {
  for (const key of ["opened", "clicked"]) {
    const ts = Number(metrics[key]);
    if (Number.isFinite(ts) && ts > row.lastEngaged) row.lastEngaged = ts;
  }
}

function suppressionStatus(row) {
  const reason = Object.entries(row.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  let status = "";
  if (row.unsubscribed) status = "unsubscribed";
  else if (row.bounced) status = "bounced";
  else if (row.undeliverable) status = "undeliverable";
  else if (row.failed) status = "failed";
  else if (row.dropped) status = "dropped";
  if (status && reason) status = `${status}: ${reason}`;
  return status.replace(/\s+/g, " ").slice(0, 500);
}

async function scanWindow(startTs, endTs, state) {
  let start = "";
  let pages = 0;
  let seen = 0;
  while (true) {
    if (LIMIT != null && state.scanned >= LIMIT) return seen;
    const url = new URL("/v1/messages", BASE);
    url.searchParams.set("type", "email");
    url.searchParams.set("drafts", "false");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("start_ts", String(startTs));
    url.searchParams.set("end_ts", String(endTs));
    if (start) url.searchParams.set("start", start);

    const body = await cioGet(url);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    pages += 1;
    for (const msg of messages) {
      if (LIMIT != null && state.scanned >= LIMIT) return seen;
      state.scanned += 1;
      seen += 1;
      const metrics = msg.metrics || {};
      const person = personKey(msg);
      const row = state.people.get(person) || emptyRow();
      for (const key of COUNTS) {
        if (metrics[key] != null) {
          state.counts[key] += 1;
          row[key] += 1;
        }
      }
      noteEngaged(row, metrics);
      let undelivered = false;
      for (const key of NON_DELIVERY) {
        if (metrics[key] != null) {
          state.nonDelivery[key] += 1;
          row[key] += 1;
          undelivered = true;
        }
      }
      if (undelivered || msg.failure_message) {
        const reason = (msg.failure_message || "(sans message)").trim();
        row.reasons[reason] = (row.reasons[reason] || 0) + 1;
      }
      state.people.set(person, row);
    }
    if (!body.next || messages.length === 0) break;
    if (body.next === start) break;
    start = body.next;
    if (pages > 100000) throw new Error("Pagination stopped: too many pages");
    await sleep(120);
  }
  return seen;
}

function isTransientNetworkError(err) {
  const code = err?.cause?.code || err?.code || "";
  const msg = String(err?.message || err || "");
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EPIPE", "EAI_AGAIN"].includes(code) ||
    msg.includes("fetch failed")
  );
}

let nextWriteAt = 0;
let rateLimitedUntil = 0;
let paceChain = Promise.resolve();

function paceWrite() {
  const interval = 1000 / ATTIO_WRITE_RPS;
  const run = paceChain.then(async () => {
    const blocked = rateLimitedUntil - Date.now();
    if (blocked > 0) await sleep(blocked);
    const now = Date.now();
    const slot = Math.max(now, nextWriteAt);
    nextWriteAt = slot + interval;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  });
  paceChain = run.catch(() => {});
  return run;
}

async function attioFetch(url, options = {}, attempt = 1) {
  const maxAttempts = Number(process.env.MAX_RETRIES || 8);
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 60000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${ATTIO_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1) * 1000;
      rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + wait);
      await sleep(wait);
      return attioFetch(url, options, attempt);
    }
    if ([502, 503, 504].includes(res.status) && attempt < maxAttempts) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 30000));
      return attioFetch(url, options, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Attio ${res.status}: ${body.slice(0, 300).replace(/[^\s@]+@[^\s@]+/g, "[email]")}`);
    }
    return res.json();
  } catch (err) {
    const timedOut =
      err?.name === "TimeoutError" ||
      err?.name === "AbortError" ||
      String(err?.message || "").includes("TimeoutError");
    if (attempt < maxAttempts && (timedOut || isTransientNetworkError(err))) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 30000));
      return attioFetch(url, options, attempt + 1);
    }
    throw err;
  }
}

function attioValues(email, row) {
  const values = {
    email_addresses: [{ email_address: email }],
    cio_sent: row.sent,
    cio_opens: row.opened,
    cio_clicked: row.clicked,
    cio_unsubscribe: row.unsubscribed > 0,
    cio_suppression_status: suppressionStatus(row),
  };
  if (row.lastEngaged) {
    values.cio_last_engaged_date = new Date(row.lastEngaged * 1000).toISOString().slice(0, 10);
  }
  return values;
}

async function upsertPerson(email, row) {
  await attioFetch(
    "https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses",
    {
      method: "PUT",
      body: JSON.stringify({ data: { values: attioValues(email, row) } }),
    },
  );
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const floor = now - LOOKBACK_MONTHS * 30 * 24 * 60 * 60;
  const state = {
    scanned: 0,
    counts: Object.fromEntries(COUNTS.map((k) => [k, 0])),
    nonDelivery: Object.fromEntries(NON_DELIVERY.map((k) => [k, 0])),
    people: new Map(),
  };

  let end = now;
  let emptyStreak = 0;
  while (end > floor) {
    if (LIMIT != null && state.scanned >= LIMIT) break;
    const start = Math.max(floor, end - WINDOW_SEC);
    const n = await scanWindow(start, end, state);
    emptyStreak = n === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2) break;
    end = start;
  }

  const people = [...state.people.entries()].filter(([email]) => email.includes("@"));
  let updated = 0;
  let failed = 0;
  if (!DRY_RUN) {
    let cursor = 0;
    async function worker() {
      while (cursor < people.length) {
        const index = cursor;
        cursor += 1;
        const [email, row] = people[index];
        try {
          await paceWrite();
          await upsertPerson(email, row);
          updated += 1;
        } catch {
          failed += 1;
        }
      }
    }
    const workers = Math.min(CONCURRENCY, people.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  console.log(`people found: ${people.length}`);
  console.log(`people updated: ${updated}`);
  console.log(`people failed: ${failed}`);
  if (failed > 0) {
    console.log(
      `::warning::Attio sync incomplete: ${updated} updated, ${failed} failed out of ${people.length}`,
    );
  }
  if (!DRY_RUN && people.length > 0 && updated === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
