#!/usr/bin/env node
/**
 * Sync LaunchDarkly flags → Attio people
 *   - ld_flags         : boolean features ON
 *   - ld_config_flags  : config values as "key=value"
 *
 * Usage:
 *   LIMIT=100 DRY_RUN=1 node sync-ld-to-attio.mjs
 *   LIMIT=1 node sync-ld-to-attio.mjs
 *   node sync-ld-to-attio.mjs
 *
 * Env:
 *   LAUCH_DARK_API / LAUNCHDARKLY_API_KEY
 *   ATTIO_API_TOKEN
 *   ATTIO_LD_FLAGS_SLUG         (default: ld_flags)
 *   ATTIO_LD_CONFIG_FLAGS_SLUG  (default: ld_config_flags)
 *   LIMIT, DRY_RUN, DELAY_MS, CONCURRENCY, VERBOSE_API
 *   SHARD_INDEX / SHARD_COUNT (e.g. 0/2 and 1/2 — no overlap)
 *   CACHE_TTL_HOURS (default 24), REFRESH_CACHE=1 to force re-list
 *   LD_RATE_CUSHION (default 0) — hard-wait only when remaining ≤ cushion
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

const LD_TOKEN =
  process.env.LAUNCHDARKLY_API_KEY || process.env.LAUCH_DARK_API || "";
const ATTIO_TOKEN = process.env.ATTIO_API_TOKEN || "";
const ATTIO_FLAGS_SLUG = process.env.ATTIO_LD_FLAGS_SLUG || "ld_flags";
const ATTIO_CONFIG_SLUG =
  process.env.ATTIO_LD_CONFIG_FLAGS_SLUG || "ld_config_flags";
const ATTIO_LAST_UPDATED_SLUG =
  process.env.ATTIO_LD_LAST_UPDATED_SLUG || "ld_last_updated";
const PROJECT = process.env.LD_PROJECT_KEY || "default";
const ENV = process.env.LD_ENVIRONMENT_KEY || "production";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
/**
 * Split the email list across jobs (no overlap).
 * SHARD_COUNT=2 SHARD_INDEX=0 → first half; SHARD_INDEX=1 → second half.
 */
const SHARD_COUNT = Math.max(1, Number(process.env.SHARD_COUNT || 1));
const SHARD_INDEX = Math.min(
  SHARD_COUNT - 1,
  Math.max(0, Number(process.env.SHARD_INDEX ?? 0)),
);
/** Pause after each email (per worker). Rate-limit pacing is mostly header-driven. */
const DELAY_MS = Number(process.env.DELAY_MS || 100);
/** Parallel emails. 2 is a good default; use 1 if LD 429s explode. */
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const VERBOSE_API =
  process.env.VERBOSE_API === "1" || process.env.VERBOSE_API === "true";
/** Hard-wait only when remaining ≤ this (0 = use full budget, rely on 429 as backstop). */
const LD_RATE_CUSHION = Math.max(0, Number(process.env.LD_RATE_CUSHION || 0));
/** Disk cache for email list + user UUID map (skips slow LD pagination). */
const CACHE_TTL_MS =
  Number(process.env.CACHE_TTL_HOURS || 24) * 60 * 60 * 1000;
const REFRESH_CACHE =
  process.env.REFRESH_CACHE === "1" || process.env.REFRESH_CACHE === "true";
const CACHE_DIR = path.join(__dirname, ".cache");
const EMAILS_CACHE_FILE = path.join(
  CACHE_DIR,
  `ld-emails-${PROJECT}-${ENV}.json`,
);
const USERS_CACHE_FILE = path.join(
  CACHE_DIR,
  `ld-users-${PROJECT}-${ENV}.json`,
);

/**
 * LaunchDarkly rate-limit state from response headers:
 *   X-Ratelimit-Global-Remaining, X-Ratelimit-Route-Remaining,
 *   X-Ratelimit-Reset (epoch ms), Retry-After (seconds on 429).
 * @see https://launchdarkly.com/docs/api
 */
const ldRateLimit = {
  globalRemaining: null,
  routeRemaining: null,
  resetAtMs: null,
};

/** Serialize LD calls so Remaining counts stay coherent with CONCURRENCY>1. */
let ldGate = Promise.resolve();

function withLdGate(fn) {
  const next = ldGate.then(fn, fn);
  ldGate = next.catch(() => {});
  return next;
}

if (!LD_TOKEN) {
  console.error("Missing LAUCH_DARK_API / LAUNCHDARKLY_API_KEY");
  process.exit(1);
}
if (!DRY_RUN && !ATTIO_TOKEN) {
  console.error("Missing ATTIO_API_TOKEN (or set DRY_RUN=1)");
  process.exit(1);
}

/** Feature / boolean-ish keys (+ wildcard *-notification-announcement). */
const FLAG_KEYS = new Set([
  "enable-recording-bot",
  "enable-in-browser-recording",
  "enable-use-display-media",
  "enable-calendar-integration",
  "enable-auto-record-calendar-events",
  "show-new-scheduled-calls",
  "custom-bot-name",
  "browser-recording-start-confirmation",
  "live_transcription",
  "live-transcription-recall",
  "in-call-live-summary",
  "post-call-streaming-summary",
  "live-call-classification",
  "enable-agentic-jgpt-v3",
  "juni-global-chatbot",
  "enable-personal-jgpt-chat",
  "enable-document-sources-jgpt",
  "enable-inline-citations",
  "enable-quote-tool",
  "enable-dynamic-juni-suggestions",
  "enable-nl-interview-filters",
  "enable-mcp",
  "ivg-generation",
  "ivg-search-library",
  "enable-interview-guide-markdown-editor",
  "agentic-loop-chat-v2",
  "enable-interview-guide-auto-checkoff",
  "enable-tracker",
  "enable-kta-chat",
  "enable-kta-agentic-chat",
  "enable-kta-generation-v2",
  "enable-transcript-library",
  "enable-transcript-library-filters",
  "enable-transcript-library-market-reports",
  "enable-report-generator",
  "thematic_transcripts",
  "enable-slide-deck",
  "enable-slide-builder",
  "enable-ppt-audit",
  "enable-ppt-audit-style-guide",
  "enable-thinkcell-service",
  "running-summaries",
  "enable-running-summary-templates",
  "enable-running-summary-citation",
  "summary-by-date-range",
  "enable-entity-benchmarking",
  "render-similar-entities",
  "competitive-analysis-generation",
  "enable-survey-module",
  "enable-survey-builder-uxr",
  "enable-survey-painted-door",
  "voice-agents-mode",
  "junior-interviewer-v1-client-test",
  "enable-desktop-app-download",
  "mobile-app-banner",
  "mobile-app-notification-announcement",
  "mobile-standalone-calls",
  "mobile-share-recording",
  "desktop-app-jgpt",
  "desktop-app-ivg-juni-chatbot",
  "desktop-app-trim-calls",
  "enable-home-v2",
  "new-project-onboarding",
  "learn-junior",
  "force-learn-junior",
  "welcome-modal",
  "book-a-demo-links",
  "show-feature-announcements",
  "feature-flags-opt-in",
  "enable-junior-wrapped",
  "cmd-k-menu-v2",
  "enable-bookmarks-folders-v2",
  "highlight-v2",
  "highlighting-quotes",
  "enable-calls-v2",
  "enable-all-calls",
  "enabled-standalone-calls",
  "enable-call-price-tracker",
  "show-project-costs",
  "enable-import-calls-from-advisors-button",
  "enable-take-notes",
  "enable-sentiment-analysis",
  "enable-duplicate-interview",
  "enable-foreign-transcript",
  "enable-original-language-transcript",
  "project_sharing",
  "project_share_linking",
  "enable-org-wide-project-visibility",
  "share-auto-provision-domains",
  "enable-bulk-upload-modal",
  "enable-enhanced-docx-parsing",
  "enable_anonymization_settings",
  "transcript_anonymization",
  "recording-confirmation-config",
  "enable-restricted-meeting-guardrail",
]);

/** Keys that are typically config (string/number), not pure booleans. */
const CONFIG_FLAG_KEYS = new Set([
  "custom-bot-name",
  "browser-recording-start-confirmation",
  "book-a-demo-links",
  "voice-agents-mode",
  "recording-confirmation-config",
  "share-auto-provision-domains",
  "feature-flags-opt-in",
]);

function isWantedFlag(key) {
  return FLAG_KEYS.has(key) || key.endsWith("-notification-announcement");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readJsonCache(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data?.savedAt) return null;
    const ageMs = Date.now() - new Date(data.savedAt).getTime();
    if (ageMs > CACHE_TTL_MS) {
      console.log(
        `  cache expired (${(ageMs / 3600000).toFixed(1)}h old): ${path.basename(file)}`,
      );
      return null;
    }
    return data;
  } catch {
    console.warn(`  cache unreadable, ignoring: ${path.basename(file)}`);
    return null;
  }
}

function writeJsonCache(file, payload) {
  ensureCacheDir();
  const body = { savedAt: new Date().toISOString(), ...payload };
  fs.writeFileSync(file, JSON.stringify(body));
  console.log(
    `  saved cache → ${path.relative(__dirname, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`,
  );
}

/**
 * Prefer disk cache for the email list (avoids ~170 LD search pages).
 * LIMIT=N with a warm cache just slices. Cold cache + LIMIT fetches only N (no write).
 */
async function getEmails(limit) {
  if (!REFRESH_CACHE) {
    const cached = readJsonCache(EMAILS_CACHE_FILE);
    if (cached?.emails?.length) {
      const ageH = (
        (Date.now() - new Date(cached.savedAt).getTime()) /
        3600000
      ).toFixed(1);
      console.log(
        `Using email cache: ${cached.emails.length} emails (saved ${cached.savedAt}, ${ageH}h ago)`,
      );
      return limit ? cached.emails.slice(0, limit) : cached.emails;
    }
  } else {
    console.log("REFRESH_CACHE=1 — re-listing emails from LD");
  }

  const emails = await listEmails(limit);
  // Only persist a full listing (LIMIT would write a truncated list)
  if (!limit) {
    writeJsonCache(EMAILS_CACHE_FILE, {
      project: PROJECT,
      environment: ENV,
      emails,
    });
  }
  return emails;
}

/**
 * Prefer disk cache for email → user UUID (avoids scanning user contexts).
 * Partial caches are reused; an unfinished scan can resume via continuationToken.
 */
function loadUsersObjectFromDisk() {
  try {
    if (!fs.existsSync(USERS_CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(USERS_CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function persistUserCache(users, extra = {}) {
  writeJsonCache(USERS_CACHE_FILE, {
    project: PROJECT,
    environment: ENV,
    users,
    ...extra,
  });
}

async function getUserCache(neededEmails) {
  if (!REFRESH_CACHE) {
    const cached = readJsonCache(USERS_CACHE_FILE);
    if (cached?.users && typeof cached.users === "object") {
      const map = new Map();
      for (const email of neededEmails) {
        const userKey = cached.users[email];
        if (userKey) map.set(email, { userKey });
      }
      const ageH = (
        (Date.now() - new Date(cached.savedAt).getTime()) /
        3600000
      ).toFixed(1);
      const coverage = map.size / Math.max(neededEmails.length, 1);
      console.log(
        `Using user cache: ${map.size}/${neededEmails.length} linked (${(coverage * 100).toFixed(0)}%, saved ${cached.savedAt}, ${ageH}h ago)`,
      );

      // Incomplete previous scan — resume instead of starting over
      if (cached.continuationToken && coverage < 0.95) {
        console.log(
          `  resuming user scan from page ${cached.pages || "?"}…`,
        );
        return buildUserCache(neededEmails, {
          seedUsers: cached.users,
          continuationToken: cached.continuationToken,
          startPages: cached.pages || 0,
        });
      }

      if (map.size > 0) return map;
    }
  } else {
    console.log("REFRESH_CACHE=1 — rebuilding user cache from LD");
  }

  return buildUserCache(neededEmails);
}

const apiStats = { ld: 0, attio: 0 };

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/api\/v2\//, "/");
    return `${u.host}${path}${u.search ? "?…" : ""}`;
  } catch {
    return url.slice(0, 80);
  }
}

function logApi(service, method, url, extra = "") {
  apiStats[service] = (apiStats[service] || 0) + 1;
  if (!VERBOSE_API) return;
  const n = apiStats.ld + apiStats.attio;
  console.log(
    `  [API #${n} ${service.toUpperCase()}] ${method} ${shortUrl(url)}${extra ? ` ${extra}` : ""}`,
  );
}

function printApiStats(label = "") {
  console.log(
    `  API totals${label ? ` ${label}` : ""}: LD=${apiStats.ld} Attio=${apiStats.attio} sum=${apiStats.ld + apiStats.attio}`,
  );
}

function isTransientNetworkError(err) {
  const code = err?.cause?.code || err?.code || "";
  const msg = String(err?.message || err || "");
  return (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EPIPE",
      "EAI_AGAIN",
    ].includes(code) ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket")
  );
}

function headerNumber(headers, name) {
  const raw = headers.get(name);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function updateLdRateLimitFromHeaders(headers) {
  const globalRem = headerNumber(headers, "x-ratelimit-global-remaining");
  const routeRem = headerNumber(headers, "x-ratelimit-route-remaining");
  const resetAt = headerNumber(headers, "x-ratelimit-reset");
  if (globalRem != null) ldRateLimit.globalRemaining = globalRem;
  if (routeRem != null) ldRateLimit.routeRemaining = routeRem;
  if (resetAt != null) {
    // Docs: epoch milliseconds. Guard if a proxy ever sends seconds.
    ldRateLimit.resetAtMs = resetAt < 1e12 ? resetAt * 1000 : resetAt;
  }
}

function ldRateLimitLabel() {
  const parts = [];
  if (ldRateLimit.routeRemaining != null) {
    parts.push(`routeLeft=${ldRateLimit.routeRemaining}`);
  }
  if (ldRateLimit.globalRemaining != null) {
    parts.push(`globalLeft=${ldRateLimit.globalRemaining}`);
  }
  return parts.join(" ") || "headers=n/a";
}

function msUntilLdReset() {
  if (ldRateLimit.resetAtMs == null) return 0;
  return Math.max(0, ldRateLimit.resetAtMs - Date.now());
}

/**
 * Pace LD calls from headers:
 *  - remaining ≤ cushion → wait until X-Ratelimit-Reset (default cushion 0)
 *  - otherwise soft-spread: sleep ~ timeLeft/remaining (capped) to avoid burst→429
 */
async function waitForLdRateBudget() {
  const remaining = Math.min(
    ldRateLimit.routeRemaining ?? Infinity,
    ldRateLimit.globalRemaining ?? Infinity,
  );
  if (remaining === Infinity) return;

  const msLeft = msUntilLdReset();

  if (remaining <= LD_RATE_CUSHION) {
    let wait = msLeft + 75;
    if (wait <= 0 || wait > 60_000) wait = 10_000;
    wait += Math.floor(Math.random() * 200);
    // Throttle spam: only log waits >= 2s
    if (wait >= 2000) {
      console.warn(
        `LD budget empty (${ldRateLimitLabel()}) — waiting ${wait}ms until reset`,
      );
    }
    await sleep(wait);
    ldRateLimit.routeRemaining = null;
    ldRateLimit.globalRemaining = null;
    return;
  }

  // Soft pacing across the window (skip tiny gaps / huge outliers)
  if (msLeft > 300 && remaining < Infinity) {
    const spacing = Math.floor(msLeft / remaining);
    const wait = Math.min(Math.max(0, spacing), 1500);
    if (wait >= 80) await sleep(wait);
  }
}

/** Wait duration for a 429: Retry-After (s) or X-Ratelimit-Reset (epoch ms). */
function waitMsFromLd429(headers) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter != null && retryAfter !== "") {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec)) {
      return Math.max(0, sec * 1000) + Math.floor(Math.random() * 250);
    }
  }
  const resetAt = headerNumber(headers, "x-ratelimit-reset");
  if (resetAt != null) {
    const resetMs = resetAt < 1e12 ? resetAt * 1000 : resetAt;
    let wait = resetMs - Date.now() + 75;
    if (wait < 500) wait = 1000;
    if (wait > 120_000) wait = 10_000;
    return wait + Math.floor(Math.random() * 250);
  }
  return 5000 + Math.floor(Math.random() * 250);
}

async function ldFetch(url, options = {}, attempt = 1) {
  return withLdGate(() => ldFetchLocked(url, options, attempt));
}

async function ldFetchLocked(url, options = {}, attempt = 1) {
  const maxAttempts = Number(process.env.MAX_RETRIES || 8);
  const method = options.method || "GET";
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 60000);

  await waitForLdRateBudget();
  logApi("ld", method, url, attempt > 1 ? `(attempt ${attempt})` : "");

  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: LD_TOKEN,
        "LD-API-Version": "20240415",
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });

    updateLdRateLimitFromHeaders(res.headers);

    if (res.status === 429) {
      const wait = waitMsFromLd429(res.headers);
      console.warn(
        `LD 429 — waiting ${wait}ms (${ldRateLimitLabel()}, retry-after=${res.headers.get("retry-after") ?? "n/a"})`,
      );
      await sleep(wait);
      ldRateLimit.routeRemaining = null;
      ldRateLimit.globalRemaining = null;
      // Stay inside the gate (do not call ldFetch → deadlock)
      return ldFetchLocked(url, options, attempt);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LD ${res.status} ${url}: ${body.slice(0, 400)}`);
    }
    return res.json();
  } catch (err) {
    const timedOut =
      err?.name === "TimeoutError" ||
      err?.name === "AbortError" ||
      String(err?.message || "").includes("TimeoutError");
    if (attempt < maxAttempts && (timedOut || isTransientNetworkError(err))) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 30000);
      console.warn(
        `LD ${timedOut ? "timeout" : "network"} (${err.cause?.code || err.message}) — retry ${attempt}/${maxAttempts} in ${wait}ms`,
      );
      await sleep(wait);
      return ldFetchLocked(url, options, attempt + 1);
    }
    throw err;
  }
}

async function attioFetch(url, options = {}, attempt = 1) {
  const maxAttempts = Number(process.env.MAX_RETRIES || 8);
  const method = options.method || "GET";
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 60000);
  logApi("attio", method, url, attempt > 1 ? `(attempt ${attempt})` : "");
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
      const wait = Number(res.headers.get("retry-after") || 3) * 1000;
      console.warn(`Attio 429 — waiting ${wait}ms`);
      await sleep(wait);
      return attioFetch(url, options, attempt);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Attio ${res.status} ${url}: ${body.slice(0, 500)}`);
    }
    return res.json();
  } catch (err) {
    const timedOut =
      err?.name === "TimeoutError" ||
      err?.name === "AbortError" ||
      String(err?.message || "").includes("TimeoutError");
    if (
      attempt < maxAttempts &&
      (timedOut || isTransientNetworkError(err))
    ) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 30000);
      console.warn(
        `Attio ${timedOut ? "timeout" : "network"} (${err.cause?.code || err.message}) — retry ${attempt}/${maxAttempts} in ${wait}ms`,
      );
      await sleep(wait);
      return attioFetch(url, options, attempt + 1);
    }
    throw err;
  }
}

async function listEmails(limit) {
  const emails = [];
  const seen = new Set();
  let continuation = null;
  let pages = 0;
  let totalCount = null;

  console.log("Listing LD email contexts...");

  while (true) {
    const body = {
      filter: 'kind anyOf ["email"]',
      limit: 50,
      includeTotalCount: pages === 0,
    };
    if (continuation) body.continuationToken = continuation;

    const data = await ldFetch(
      `https://app.launchdarkly.com/api/v2/projects/${PROJECT}/environments/${ENV}/contexts/search`,
      { method: "POST", body: JSON.stringify(body) },
    );

    if (pages === 0) {
      totalCount = data.totalCount ?? null;
      console.log(`LD email contexts totalCount=${totalCount ?? "?"}`);
    }

    for (const item of data.items || []) {
      const key = (item.context?.key || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      emails.push(key);
      if (limit && emails.length >= limit) {
        console.log(`  listed ${emails.length} emails (LIMIT hit, ${pages + 1} pages)`);
        return emails;
      }
    }

    continuation = data.continuationToken;
    pages += 1;
    if (pages % 20 === 0 || !continuation) {
      const of = totalCount != null ? `/${totalCount}` : "";
      console.log(`  listed ${emails.length}${of} emails (${pages} pages)...`);
    }
    if (!continuation || !(data.items || []).length) break;
    await sleep(40);
  }

  console.log(`Listed ${emails.length} unique emails (${pages} pages)`);
  return emails;
}

async function buildUserCache(neededEmails, opts = {}) {
  const needed = new Set([...neededEmails].map((e) => e.toLowerCase()));
  const map = new Map();
  const usersObj = {};

  // Seed from previous partial progress
  if (opts.seedUsers && typeof opts.seedUsers === "object") {
    for (const [email, userKey] of Object.entries(opts.seedUsers)) {
      if (!userKey) continue;
      usersObj[email] = userKey;
      if (needed.has(email)) {
        map.set(email, { userKey });
        needed.delete(email);
      }
    }
  } else {
    const prev = loadUsersObjectFromDisk();
    if (prev?.users) {
      for (const [email, userKey] of Object.entries(prev.users)) {
        if (!userKey) continue;
        usersObj[email] = userKey;
        if (needed.has(email)) {
          map.set(email, { userKey });
          needed.delete(email);
        }
      }
    }
  }

  let continuation = opts.continuationToken || null;
  let pages = opts.startPages || 0;

  console.log(
    `Building user cache for ${needed.size} emails still missing` +
      (map.size ? ` (${map.size} already cached)` : "") +
      (continuation ? `, resuming…` : "…"),
  );

  while (needed.size > 0) {
    const body = { filter: 'kind anyOf ["user"]', limit: 50 };
    if (continuation) body.continuationToken = continuation;

    const data = await ldFetch(
      `https://app.launchdarkly.com/api/v2/projects/${PROJECT}/environments/${ENV}/contexts/search`,
      { method: "POST", body: JSON.stringify(body) },
    );

    for (const item of data.items || []) {
      const ctx = item.context || {};
      const email = (ctx.email || "").trim().toLowerCase();
      const userKey = ctx.key;
      if (!email || !userKey || !needed.has(email)) continue;
      if (!map.has(email)) {
        map.set(email, { userKey });
        usersObj[email] = userKey;
        needed.delete(email);
      }
    }

    continuation = data.continuationToken || null;
    pages += 1;
    if (pages % 20 === 0 || !continuation || needed.size === 0) {
      console.log(
        `  user cache: ${map.size} matched, ${needed.size} remaining (${pages} pages)`,
      );
      // Persist progress so Ctrl+C doesn't throw away minutes of work
      persistUserCache(usersObj, {
        continuationToken: continuation || null,
        pages,
        complete: !continuation || needed.size === 0,
      });
    }
    if (!continuation || !(data.items || []).length) break;
    if (pages >= 200 && map.size > 0) {
      console.log(
        `  stopping user cache early at ${pages} pages (${map.size} matched)`,
      );
      break;
    }
    await sleep(40);
  }

  persistUserCache(usersObj, {
    continuationToken: null,
    pages,
    complete: true,
  });

  console.log(
    `User cache: ${map.size}/${neededEmails.length} emails linked to a user UUID`,
  );
  return map;
}

async function evaluateFlags(email, userInfo) {
  let body;
  if (userInfo?.userKey) {
    body = {
      kind: "multi",
      user: { key: userInfo.userKey, email },
      email: { key: email },
    };
  } else {
    body = { key: email, kind: "email" };
  }

  const data = await ldFetch(
    `https://app.launchdarkly.com/api/v2/projects/${PROJECT}/environments/${ENV}/flags/evaluate`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return data.items || [];
}

/**
 * Split LD evaluate results into:
 *  - featureFlags: boolean true (+ opt-in subs)
 *  - configFlags:  "key=value" for configs / strings
 */
function extractFlags(items) {
  const featureFlags = [];
  const configFlags = [];

  for (const item of items) {
    const key = item.key;
    if (!isWantedFlag(key)) continue;
    const v = item._value;

    if (v === true) {
      featureFlags.push(key);
      continue;
    }
    if (v === false || v === null || v === undefined || v === "") continue;

    if (Array.isArray(v)) {
      if (key === "feature-flags-opt-in") {
        const subs = v
          .map((sub) => (typeof sub === "object" && sub ? sub.key : sub))
          .filter(Boolean);
        if (subs.length) {
          featureFlags.push(key, ...subs);
          // also store full payload summary as config
          configFlags.push(`${key}=${subs.join("+")}`);
        }
      }
      continue;
    }

    if (typeof v === "string" || typeof v === "number") {
      const truncated =
        typeof v === "string" && v.length > 80
          ? `${v.slice(0, 77)}...`
          : String(v);
      configFlags.push(`${key}=${truncated}`);
    }
  }

  return {
    featureFlags: [...new Set(featureFlags)].sort(),
    configFlags: [...new Set(configFlags)].sort(),
  };
}

/** In-memory cache of options already known to exist in Attio (per attribute slug). */
const optionsCache = new Map(); // slug → Set<title>

async function listExistingOptions(attributeSlug) {
  const data = await attioFetch(
    `https://api.attio.com/v2/objects/people/attributes/${attributeSlug}/options?show_archived=false`,
  );
  const titles = new Set((data.data || []).map((o) => o.title));
  optionsCache.set(attributeSlug, titles);
  console.log(`  ${attributeSlug}: ${titles.size} options already in Attio`);
  return titles;
}

async function createMissingOptions(attributeSlug, titles) {
  let existing = optionsCache.get(attributeSlug);
  if (!existing) {
    existing = await listExistingOptions(attributeSlug);
  }

  const missing = [...new Set(titles)].filter((t) => t && !existing.has(t));
  if (!missing.length) return; // silent when nothing to create

  console.log(
    `  ${attributeSlug}: creating ${missing.length} missing options...`,
  );
  let created = 0;
  for (const title of missing) {
    try {
      await attioFetch(
        `https://api.attio.com/v2/objects/people/attributes/${attributeSlug}/options`,
        { method: "POST", body: JSON.stringify({ data: { title } }) },
      );
      existing.add(title);
      created += 1;
    } catch (err) {
      // Option may already exist
      if (String(err.message).includes("400")) {
        existing.add(title);
        created += 1;
      } else {
        throw err;
      }
    }
    await sleep(60);
  }
  console.log(`  ${attributeSlug}: done (${created} created/ensured)`);
}

/**
 * Upfront: list existing options, create all known FLAG_KEYS for ld_flags.
 * Config options (key=value) are created later when we discover values.
 * Note: Attio has NO batch create endpoint — 1 POST per missing option.
 */
async function bootstrapAttioOptions() {
  console.log("Bootstrapping Attio select options...");
  await listExistingOptions(ATTIO_FLAGS_SLUG);
  await listExistingOptions(ATTIO_CONFIG_SLUG);

  // All known feature flag keys as options on ld_flags
  await createMissingOptions(ATTIO_FLAGS_SLUG, [...FLAG_KEYS]);
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD for Attio date attrs
}

async function upsertAttio(email, featureFlags, configFlags) {
  // Ensure any new titles (e.g. *-notification-announcement, new config=value)
  await createMissingOptions(ATTIO_FLAGS_SLUG, featureFlags);
  await createMissingOptions(ATTIO_CONFIG_SLUG, configFlags);

  const values = {
    email_addresses: [{ email_address: email }],
    [ATTIO_FLAGS_SLUG]: featureFlags,
    [ATTIO_CONFIG_SLUG]: configFlags,
    [ATTIO_LAST_UPDATED_SLUG]: todayUtcDate(),
  };

  return attioFetch(
    `https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses`,
    {
      method: "PUT",
      body: JSON.stringify({ data: { values } }),
    },
  );
}

function logLine(...args) {
  // Force flush so GitHub Actions live logs don't appear "stuck"
  console.log(...args);
  if (typeof process.stdout?.write === "function") {
    try {
      process.stdout.write("");
    } catch {
      /* ignore */
    }
  }
}

/** Contiguous slice so shards never overlap (0 = first half, 1 = second, …). */
function takeShard(items, shardIndex, shardCount) {
  if (shardCount <= 1) return items;
  const n = items.length;
  const start = Math.floor((n * shardIndex) / shardCount);
  const end = Math.floor((n * (shardIndex + 1)) / shardCount);
  return items.slice(start, end);
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  logLine("=== LD → Attio sync ===");
  logLine(
    `LIMIT=${LIMIT ?? "all"} DRY_RUN=${DRY_RUN} DELAY_MS=${DELAY_MS} CONCURRENCY=${CONCURRENCY} SHARD=${SHARD_INDEX}/${SHARD_COUNT}`,
  );
  logLine(`Features slug: ${ATTIO_FLAGS_SLUG}`);
  logLine(`Config slug:   ${ATTIO_CONFIG_SLUG}`);

  if (!DRY_RUN) {
    await bootstrapAttioOptions();
  }

  const allEmails = await getEmails(LIMIT);
  const emails = takeShard(allEmails, SHARD_INDEX, SHARD_COUNT);
  logLine(
    `Emails: ${allEmails.length} total → shard ${SHARD_INDEX}/${SHARD_COUNT} = ${emails.length} to process`,
  );

  const userCache = await getUserCache(emails);

  let ok = 0;
  let fail = 0;
  let done = 0;
  let inFlight = 0;
  const startedAt = Date.now();
  const samples = [];
  let nextIndex = 0;
  const EMAIL_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || 180_000);

  const heartbeat = setInterval(() => {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    logLine(
      `  heartbeat t=${mins}m done=${done}/${emails.length} ok=${ok} fail=${fail} inFlight=${inFlight} ${ldRateLimitLabel()}`,
    );
  }, 60_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  async function processOne(i) {
    const email = emails[i];
    inFlight += 1;
    try {
      await withTimeout(
        (async () => {
          const items = await evaluateFlags(email, userCache.get(email));
          const { featureFlags, configFlags } = extractFlags(items);

          if (samples.length < 5) {
            samples.push({
              email,
              featureFlags,
              configFlags,
              mode: userCache.has(email) ? "multi" : "email",
            });
          }

          if (!DRY_RUN) {
            await upsertAttio(email, featureFlags, configFlags);
          }
        })(),
        EMAIL_TIMEOUT_MS,
        `email #${i + 1}`,
      );

      ok += 1;
    } catch (err) {
      fail += 1;
      console.error(`  FAIL #${i + 1}: ${err.message}`);
    } finally {
      inFlight -= 1;
    }

    done += 1;
    if (done % 10 === 0 || done === emails.length) {
      logLine(
        `  [${done}/${emails.length}] ok=${ok} fail=${fail} ${ldRateLimitLabel()}`,
      );
      printApiStats(`@${done}`);
    }

    await sleep(DELAY_MS);
  }

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= emails.length) return;
      await processOne(i);
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, emails.length) }, () =>
        worker(),
      ),
    );
  } finally {
    clearInterval(heartbeat);
  }

  console.log("\n=== Sample results ===");
  for (let sIdx = 0; sIdx < samples.length; sIdx++) {
    const s = samples[sIdx];
    console.log(`\nSample ${sIdx + 1} (${s.mode})`);
    console.log(
      `  LD flags (${s.featureFlags.length}): ${s.featureFlags.join(", ") || "(none)"}`,
    );
    console.log(
      `  LD config flags (${s.configFlags.length}): ${s.configFlags.join(", ") || "(none)"}`,
    );
  }

  console.log(
    `\nDone. ok=${ok} fail=${fail}${DRY_RUN ? " (dry run — Attio not updated)" : ""}`,
  );
  printApiStats("(final)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
