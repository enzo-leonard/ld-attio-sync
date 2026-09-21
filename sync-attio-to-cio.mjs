#!/usr/bin/env node
/**
 * Sync Attio people → Customer.io (Track API identify).
 *
 * Only people with a non-empty Attio `ld_flags` multi-select are synced.
 * Flags are split into 3 array attributes (CIO 1000B limit per value):
 *   ld_flags_calls | ld_flags_ai | ld_flags_product
 * Also forwards ld_config_flags / ld_last_updated, plus:
 *   sb_created_at, sb_updated_at, sb_is_beta_access,
 *   email_consent → klaviyo_email_consent,
 *   job_title, company_name (resolved from Attio company),
 *   attio_last_interaction (unix ts from last_interaction)
 *
 * Usage:
 *   LIMIT=20 DRY_RUN=1 node sync-attio-to-cio.mjs
 *   EMAIL=someone@example.com node sync-attio-to-cio.mjs
 *   EMAILS_FILE=.cache/ld-synced-emails.json node sync-attio-to-cio.mjs
 *   LIMIT=100 node sync-attio-to-cio.mjs
 *   node sync-attio-to-cio.mjs
 *
 * Env:
 *   ATTIO_API_TOKEN
 *   CUSTOMERIO_SITE_ID
 *   CUSTOMERIO_API_KEY          (Track API key)
 *   CUSTOMERIO_REGION           (us | eu, default: us)
 *   CUSTOMERIO_ID_ATTR          (email | attio_id, default: email)
 *   ATTIO_LD_FLAGS_SLUG         (default: ld_flags)
 *   EMAIL                       (sync only this email, if set)
 *   EMAILS_FILE                 (JSON array of emails; sync only those)
 *   LIMIT, DRY_RUN, DELAY_MS, PAGE_SIZE, BATCH_SIZE
 *   EXTRA_ATTR_SLUGS            (comma-separated Attio attribute slugs to forward)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitFlagsByCategory } from "./ld-flags-shared.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    // Strip inline comments: VALUE # comment
    const cleaned = raw.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    process.env[key] = cleaned;
  }
}
loadEnv();

const ATTIO_TOKEN = process.env.ATTIO_API_TOKEN || "";
const CIO_SITE_ID = process.env.CUSTOMERIO_SITE_ID || "";
const CIO_API_KEY = process.env.CUSTOMERIO_API_KEY || "";
const CIO_REGION = (process.env.CUSTOMERIO_REGION || "us").toLowerCase();
const CIO_ID_ATTR = (process.env.CUSTOMERIO_ID_ATTR || "email").toLowerCase();
const LD_FLAGS_SLUG = process.env.ATTIO_LD_FLAGS_SLUG || "ld_flags";
const LD_CONFIG_SLUG =
  process.env.ATTIO_LD_CONFIG_FLAGS_SLUG || "ld_config_flags";
const LD_LAST_UPDATED_SLUG =
  process.env.ATTIO_LD_LAST_UPDATED_SLUG || "ld_last_updated";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const EMAIL = (process.env.EMAIL || "").trim().toLowerCase() || null;
const EMAILS_FILE = (process.env.EMAILS_FILE || "").trim() || null;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const DELAY_MS = Number(process.env.DELAY_MS || 50);
const PAGE_SIZE = Math.min(500, Math.max(1, Number(process.env.PAGE_SIZE || 100)));
const BATCH_SIZE = Math.min(1000, Math.max(1, Number(process.env.BATCH_SIZE || 100)));
const EXTRA_ATTR_SLUGS = (process.env.EXTRA_ATTR_SLUGS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CIO_TRACK_BASE =
  CIO_REGION === "eu"
    ? "https://track-eu.customer.io"
    : "https://track.customer.io";

if (!ATTIO_TOKEN) {
  console.error("Missing ATTIO_API_TOKEN");
  process.exit(1);
}
if (!DRY_RUN && (!CIO_SITE_ID || !CIO_API_KEY)) {
  console.error(
    "Missing CUSTOMERIO_SITE_ID / CUSTOMERIO_API_KEY (or set DRY_RUN=1)",
  );
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    ].includes(code) || msg.includes("fetch failed")
  );
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
    if (attempt < maxAttempts && (timedOut || isTransientNetworkError(err))) {
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

async function cioFetch(url, options = {}, attempt = 1) {
  const maxAttempts = Number(process.env.MAX_RETRIES || 8);
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 60000);
  const auth = Buffer.from(`${CIO_SITE_ID}:${CIO_API_KEY}`).toString("base64");
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 5) * 1000;
      console.warn(`CIO 429 — waiting ${wait}ms`);
      await sleep(wait);
      return cioFetch(url, options, attempt);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CIO ${res.status} ${url}: ${body.slice(0, 500)}`);
    }
    // Track API often returns empty body on success
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    const timedOut =
      err?.name === "TimeoutError" ||
      err?.name === "AbortError" ||
      String(err?.message || "").includes("TimeoutError");
    if (attempt < maxAttempts && (timedOut || isTransientNetworkError(err))) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 30000);
      console.warn(
        `CIO ${timedOut ? "timeout" : "network"} (${err.cause?.code || err.message}) — retry ${attempt}/${maxAttempts} in ${wait}ms`,
      );
      await sleep(wait);
      return cioFetch(url, options, attempt + 1);
    }
    throw err;
  }
}

function firstValue(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
}

function selectTitles(values) {
  if (!Array.isArray(values) || !values.length) return undefined;
  const titles = values
    .map((x) => x?.option?.title)
    .filter((t) => typeof t === "string" && t.length);
  return titles.length ? titles : undefined;
}

/** CIO caps each attribute value at 1000 bytes (JSON-serialized). */
const CIO_ATTR_MAX_BYTES = Number(process.env.CIO_ATTR_MAX_BYTES || 1000);

function arrayAttr(titles) {
  if (!titles?.length) return undefined;
  const arr = [...titles];
  const bytes = Buffer.byteLength(JSON.stringify(arr), "utf8");
  if (bytes > CIO_ATTR_MAX_BYTES) {
    throw new Error(
      `attribute array exceeds ${CIO_ATTR_MAX_BYTES}B (${bytes}B, ${arr.length} items)`,
    );
  }
  return arr;
}

function scalarFromAttr(values) {
  if (!Array.isArray(values) || !values.length) return undefined;
  // Multi-select / select → array (or single string if one option)
  if (values.some((x) => x?.option?.title)) {
    const titles = selectTitles(values);
    if (!titles) return undefined;
    return titles.length === 1 ? titles[0] : titles;
  }
  const v = firstValue(values);
  if (v == null) return undefined;
  if (typeof v.value === "string" || typeof v.value === "number" || typeof v.value === "boolean") {
    return v.value;
  }
  if (typeof v.status?.title === "string") return v.status.title;
  if (typeof v.currency_value === "number") return v.currency_value;
  if (typeof v.target_record_id === "string") return v.target_record_id;
  return undefined;
}

function interactionUnix(values) {
  const v = firstValue(values);
  const raw = v?.interacted_at;
  if (!raw) return undefined;
  const ts = Math.floor(new Date(raw).getTime() / 1000);
  return Number.isFinite(ts) ? ts : undefined;
}

/** Cache Attio company record_id → name */
const companyNameCache = new Map();

async function companyNameFor(recordId) {
  if (!recordId) return undefined;
  if (companyNameCache.has(recordId)) return companyNameCache.get(recordId);
  try {
    const data = await attioFetch(
      `https://api.attio.com/v2/objects/companies/records/${recordId}`,
    );
    const name = firstValue(data?.data?.values?.name)?.value || undefined;
    companyNameCache.set(recordId, name);
    return name;
  } catch (err) {
    console.warn(`company ${recordId}: ${err.message}`);
    companyNameCache.set(recordId, undefined);
    return undefined;
  }
}

/** Map one Attio person record → Customer.io identify payload (or null if skipped). */
async function personFromAttio(record) {
  const values = record.values || {};
  const recordId = record.id?.record_id;
  const emailEntry = firstValue(values.email_addresses);
  const email = (emailEntry?.email_address || "").trim().toLowerCase();
  if (!email) return null;

  // Require non-empty LD flags on Attio
  const ldFlags = selectTitles(values[LD_FLAGS_SLUG]);
  if (!ldFlags?.length) return null;

  const name = firstValue(values.name);
  const phone = firstValue(values.phone_numbers)?.phone_number;
  const jobTitle = scalarFromAttr(values.job_title);

  const attributes = {
    email,
    attio_record_id: recordId,
  };

  const byCat = splitFlagsByCategory(ldFlags);
  const callsArr = arrayAttr(byCat.calls);
  const aiArr = arrayAttr(byCat.ai);
  const productArr = arrayAttr(byCat.product);
  if (callsArr) attributes.ld_flags_calls = callsArr;
  if (aiArr) attributes.ld_flags_ai = aiArr;
  if (productArr) attributes.ld_flags_product = productArr;

  if (name?.first_name) attributes.first_name = name.first_name;
  if (name?.last_name) attributes.last_name = name.last_name;
  if (name?.full_name) attributes.full_name = name.full_name;
  if (phone) attributes.phone = phone;
  if (jobTitle != null) attributes.job_title = jobTitle;

  const companyId = firstValue(values.company)?.target_record_id;
  const companyName = await companyNameFor(companyId);
  if (companyName) attributes.company_name = companyName;

  const lastInteraction = interactionUnix(values.last_interaction);
  if (lastInteraction != null) attributes.attio_last_interaction = lastInteraction;

  const ldConfig = selectTitles(values[LD_CONFIG_SLUG]);
  const configArr = arrayAttr(ldConfig);
  if (configArr) attributes[LD_CONFIG_SLUG] = configArr;

  const ldUpdated = scalarFromAttr(values[LD_LAST_UPDATED_SLUG]);
  if (ldUpdated != null) attributes[LD_LAST_UPDATED_SLUG] = ldUpdated;

  // Attio slug → CIO attribute name
  const forwardAttrs = {
    sb_created_at: "sb_created_at",
    sb_updated_at: "sb_updated_at",
    sb_is_beta_access: "sb_is_beta_access",
    email_consent: "klaviyo_email_consent",
  };
  for (const [attioSlug, cioKey] of Object.entries(forwardAttrs)) {
    if (!values[attioSlug]?.length) continue;
    const mapped = scalarFromAttr(values[attioSlug]);
    if (mapped !== undefined) attributes[cioKey] = mapped;
  }

  for (const slug of EXTRA_ATTR_SLUGS) {
    if (!values[slug] || slug === LD_FLAGS_SLUG || forwardAttrs[slug]) continue;
    const mapped = scalarFromAttr(values[slug]);
    if (mapped !== undefined) attributes[slug] = mapped;
  }

  const created = firstValue(values.created_at)?.value;
  if (created) {
    const ts = Math.floor(new Date(created).getTime() / 1000);
    if (Number.isFinite(ts)) attributes.created_at = ts;
  }

  const identifiers =
    CIO_ID_ATTR === "attio_id" && recordId
      ? { id: recordId, email }
      : { email };

  return { identifiers, attributes };
}

function loadEmailSet() {
  if (!EMAILS_FILE) return null;
  if (!fs.existsSync(EMAILS_FILE)) {
    throw new Error(`EMAILS_FILE not found: ${EMAILS_FILE}`);
  }
  const parsed = JSON.parse(fs.readFileSync(EMAILS_FILE, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`EMAILS_FILE must be a JSON array: ${EMAILS_FILE}`);
  }
  return new Set(
    parsed.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean),
  );
}

function rowEmail(row) {
  return (row?.values?.email_addresses?.[0]?.email_address || "")
    .trim()
    .toLowerCase();
}

async function listAttioPeople(limit) {
  const people = [];
  let offset = 0;
  let pages = 0;
  let scanned = 0;

  if (EMAIL) {
    console.log(`Fetching Attio person ${EMAIL}...`);
    const data = await attioFetch(
      "https://api.attio.com/v2/objects/people/records/query",
      {
        method: "POST",
        body: JSON.stringify({
          filter: { email_addresses: { email_address: { $eq: EMAIL } } },
          limit: 1,
          offset: 0,
        }),
      },
    );
    const row = (data.data || [])[0];
    if (!row) {
      console.error(`No Attio person found for ${EMAIL}`);
      return [];
    }
    const person = await personFromAttio(row);
    if (!person) {
      console.error(
        `${EMAIL} found but skipped (missing email or empty ${LD_FLAGS_SLUG})`,
      );
      return [];
    }
    return [person];
  }

  const wanted = loadEmailSet();
  console.log(
    wanted
      ? `Listing Attio people in EMAILS_FILE (${wanted.size}) with non-empty ${LD_FLAGS_SLUG}...`
      : `Listing Attio people with non-empty ${LD_FLAGS_SLUG}...`,
  );

  while (true) {
    const data = await attioFetch(
      "https://api.attio.com/v2/objects/people/records/query",
      {
        method: "POST",
        body: JSON.stringify({
          // Email attrs don't support $not_empty; "@" matches any real address.
          // Select attrs don't support $not_empty either → filter ld_flags client-side.
          filter: { email_addresses: { $contains: "@" } },
          limit: PAGE_SIZE,
          offset,
        }),
      },
    );

    const rows = data.data || [];
    if (!rows.length) break;

    scanned += rows.length;
    for (const row of rows) {
      if (wanted && !wanted.has(rowEmail(row))) continue;
      const person = await personFromAttio(row);
      if (!person) continue;
      people.push(person);
      if (limit != null && people.length >= limit) break;
      if (wanted && people.length >= wanted.size) break;
    }

    pages += 1;
    offset += rows.length;
    console.log(
      `  listed ${people.length} with ${LD_FLAGS_SLUG} (scanned ${scanned}, ${pages} pages)...`,
    );

    if (rows.length < PAGE_SIZE) break;
    if (limit != null && people.length >= limit) break;
    if (wanted && people.length >= wanted.size) break;
  }

  return limit != null ? people.slice(0, limit) : people;
}

async function identifyBatch(people) {
  const batch = people.map((p) => ({
    type: "person",
    action: "identify",
    identifiers: p.identifiers,
    attributes: p.attributes,
  }));

  return cioFetch(`${CIO_TRACK_BASE}/api/v2/batch`, {
    method: "POST",
    body: JSON.stringify({ batch }),
  });
}

async function main() {
  console.log("=== Attio people → Customer.io ===");
  console.log(`Dry run:     ${DRY_RUN}`);
  console.log(`Region:      ${CIO_REGION} (${CIO_TRACK_BASE})`);
  console.log(`ID attr:     ${CIO_ID_ATTR}`);
  console.log(`Require:     ${LD_FLAGS_SLUG} non-empty`);
  console.log(
    `Email:       ${EMAIL ?? (EMAILS_FILE ? EMAILS_FILE : "(all matching)")}`,
  );
  console.log(`Limit:       ${LIMIT ?? "all"}`);
  console.log(`Batch size:  ${BATCH_SIZE}`);
  console.log(`Flag format: array`);
  if (EXTRA_ATTR_SLUGS.length) {
    console.log(`Extra attrs: ${EXTRA_ATTR_SLUGS.join(", ")}`);
  }

  const people = await listAttioPeople(LIMIT);
  console.log(`\nReady to sync ${people.length} people`);

  if (DRY_RUN) {
    for (const p of people.slice(0, 5)) {
      console.log(
        `  sample: ${JSON.stringify({ identifiers: p.identifiers, attributes: p.attributes })}`,
      );
    }
    if (people.length > 5) console.log(`  ... +${people.length - 5} more`);
    console.log(`\nDone. ok=0 fail=0 (dry run — CIO not updated)`);
    return;
  }

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < people.length; i += BATCH_SIZE) {
    const chunk = people.slice(i, i + BATCH_SIZE);
    const label = `${i + 1}-${i + chunk.length}/${people.length}`;
    try {
      await identifyBatch(chunk);
      ok += chunk.length;
      console.log(`  ok ${label}`);
    } catch (err) {
      fail += chunk.length;
      console.error(`  fail ${label}: ${err.message}`);
    }
    if (DELAY_MS > 0 && i + BATCH_SIZE < people.length) await sleep(DELAY_MS);
  }

  console.log(`\nDone. ok=${ok} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
