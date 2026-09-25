#!/usr/bin/env node
/**
 * Read-only Customer.io email metrics.
 * Counts sent, opened, clicked, unsubscribed, and non-delivery
 * across every sent email, and groups bounce/failure responses.
 * Does not write to Customer.io, Attio, or anywhere else.
 *
 * Usage:
 *   LIMIT=200 node sync-cio-email-metrics.mjs
 *   node sync-cio-email-metrics.mjs
 *
 * Env:
 *   CUSTOMERIO_APP_API_KEY   App API key (Bearer). Tracking API key will not work.
 *   CUSTOMERIO_REGION        us (default) | eu
 *   LIMIT                    Max deliveries to scan (empty = all)
 *   LOOKBACK_MONTHS          How far back to walk (default 120). Stops after
 *                            two empty 6-month windows.
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
    reasons: {},
  };
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
  let coveredStart = now;
  let emptyStreak = 0;
  console.error(
    `Lecture Customer.io (${REGION}) — emails envoyés, sans écriture` +
      (LIMIT != null ? `, limite ${LIMIT}` : ""),
  );

  while (end > floor) {
    if (LIMIT != null && state.scanned >= LIMIT) break;
    const start = Math.max(floor, end - WINDOW_SEC);
    const n = await scanWindow(start, end, state);
    coveredStart = start;
    const from = new Date(start * 1000).toISOString().slice(0, 10);
    const to = new Date(end * 1000).toISOString().slice(0, 10);
    console.error(`  ${from} → ${to}: ${n} emails`);
    emptyStreak = n === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2) break;
    end = start;
  }

  const rows = [...state.people.entries()].sort((a, b) => b[1].sent - a[1].sent);
  console.error("");
  console.error(
    `Fenêtre: ${new Date(coveredStart * 1000).toISOString().slice(0, 10)} → ${new Date(now * 1000).toISOString().slice(0, 10)} — ${rows.length} people, ${state.scanned} envois`,
  );
  const header = ["email", "sent", "open", "click", "unsub", "bounce", "failed", "undeliv", "dropped", "non_delivery"];
  const csv = (values) =>
    values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",");
  console.log(csv(header));
  for (const [email, row] of rows) {
    const topReason = Object.entries(row.reasons).sort((a, b) => b[1] - a[1])[0];
    console.log(
      csv([
        email,
        row.sent,
        row.opened,
        row.clicked,
        row.unsubscribed,
        row.bounced,
        row.failed,
        row.undeliverable,
        row.dropped,
        topReason ? topReason[0].replace(/\s+/g, " ") : "",
      ]),
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
