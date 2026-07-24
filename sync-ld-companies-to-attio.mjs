#!/usr/bin/env node
/**
 * Sync LaunchDarkly organization flags → Attio companies (multi-select).
 *
 * Prerequisites in Attio (Companies object):
 *   - Multi-select "LD flags"        → slug ld_flags
 *   - Multi-select "LD config flags" → slug ld_config_flags
 *
 * Matching: Attio companies use unique `domains`.
 *   We map LD org name → domain (see ORG_NAME_TO_DOMAIN in ld-flags-shared.mjs).
 *
 * Usage:
 *   LIMIT=5 DRY_RUN=1 node sync-ld-companies-to-attio.mjs
 *   LIMIT=5 node sync-ld-companies-to-attio.mjs
 *   node sync-ld-companies-to-attio.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLAG_KEYS,
  extractFlags,
  domainForOrg,
} from "./ld-flags-shared.mjs";

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
const PROJECT = process.env.LD_PROJECT_KEY || "default";
const ENV = process.env.LD_ENVIRONMENT_KEY || "production";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const DELAY_MS = Number(process.env.DELAY_MS || 300);

if (!LD_TOKEN) {
  console.error("Missing LAUCH_DARK_API / LAUNCHDARKLY_API_KEY");
  process.exit(1);
}
if (!DRY_RUN && !ATTIO_TOKEN) {
  console.error("Missing ATTIO_API_TOKEN (or set DRY_RUN=1)");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNetworkError(err) {
  const code = err?.cause?.code || err?.code || "";
  const msg = String(err?.message || err || "");
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EPIPE", "EAI_AGAIN"].includes(
      code,
    ) || msg.includes("fetch failed")
  );
}

async function ldFetch(url, options = {}, attempt = 1) {
  const maxAttempts = Number(process.env.MAX_RETRIES || 8);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: LD_TOKEN,
        "LD-API-Version": "20240415",
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (res.status === 429) {
      await sleep(Number(res.headers.get("retry-after") || 5) * 1000);
      return ldFetch(url, options, attempt);
    }
    if (!res.ok) {
      throw new Error(`LD ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    return res.json();
  } catch (err) {
    if (attempt < maxAttempts && isTransientNetworkError(err)) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 30000);
      console.warn(
        `LD network error (${err.cause?.code || err.message}) — retry ${attempt}/${maxAttempts} in ${wait}ms`,
      );
      await sleep(wait);
      return ldFetch(url, options, attempt + 1);
    }
    throw err;
  }
}

async function attioFetch(url, options = {}, attempt = 1) {
  const maxAttempts = Number(process.env.MAX_RETRIES || 8);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${ATTIO_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (res.status === 429) {
      await sleep(Number(res.headers.get("retry-after") || 3) * 1000);
      return attioFetch(url, options, attempt);
    }
    if (!res.ok) {
      throw new Error(`Attio ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    return res.json();
  } catch (err) {
    if (attempt < maxAttempts && isTransientNetworkError(err)) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 30000);
      console.warn(
        `Attio network error (${err.cause?.code || err.message}) — retry ${attempt}/${maxAttempts} in ${wait}ms`,
      );
      await sleep(wait);
      return attioFetch(url, options, attempt + 1);
    }
    throw err;
  }
}

async function listOrganizations(limit) {
  const orgs = [];
  const seen = new Set();
  let continuation = null;
  let pages = 0;

  while (true) {
    const body = {
      filter: 'kind anyOf ["organization"]',
      limit: 50,
      includeTotalCount: pages === 0,
    };
    if (continuation) body.continuationToken = continuation;

    const data = await ldFetch(
      `https://app.launchdarkly.com/api/v2/projects/${PROJECT}/environments/${ENV}/contexts/search`,
      { method: "POST", body: JSON.stringify(body) },
    );

    if (pages === 0) {
      console.log(`LD organizations totalCount=${data.totalCount ?? "?"}`);
    }

    for (const item of data.items || []) {
      const ctx = item.context || {};
      const key = ctx.key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      orgs.push({
        key,
        name: ctx.name || null,
        domain: domainForOrg(ctx.name, key),
      });
      if (limit && orgs.length >= limit) return orgs;
    }

    continuation = data.continuationToken;
    pages += 1;
    if (!continuation || !(data.items || []).length) break;
    await sleep(100);
  }

  return orgs;
}

async function evaluateOrg(org) {
  const body = {
    key: org.key,
    kind: "organization",
    ...(org.name ? { name: org.name } : {}),
  };
  const data = await ldFetch(
    `https://app.launchdarkly.com/api/v2/projects/${PROJECT}/environments/${ENV}/flags/evaluate`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return data.items || [];
}

const optionsCache = new Map();

async function listExistingOptions(attributeSlug) {
  const data = await attioFetch(
    `https://api.attio.com/v2/objects/companies/attributes/${attributeSlug}/options?show_archived=false`,
  );
  const titles = new Set((data.data || []).map((o) => o.title));
  optionsCache.set(attributeSlug, titles);
  console.log(`  companies/${attributeSlug}: ${titles.size} options exist`);
  return titles;
}

async function createMissingOptions(attributeSlug, titles) {
  let existing = optionsCache.get(attributeSlug);
  if (!existing) existing = await listExistingOptions(attributeSlug);

  const missing = [...new Set(titles)].filter((t) => t && !existing.has(t));
  if (!missing.length) return;

  console.log(`  companies/${attributeSlug}: creating ${missing.length} options...`);
  for (const title of missing) {
    const res = await fetch(
      `https://api.attio.com/v2/objects/companies/attributes/${attributeSlug}/options`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ATTIO_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ data: { title } }),
      },
    );
    if (res.ok || res.status === 400) {
      existing.add(title);
      if (!res.ok) await res.text();
    } else if (res.status === 429) {
      await sleep(3000);
      continue; // will retry next loop iteration conceptually — recreate
    } else {
      throw new Error(
        `Option "${title}" on ${attributeSlug}: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
    await sleep(60);
  }
}

async function bootstrapOptions() {
  console.log("Bootstrapping company select options...");
  await listExistingOptions(ATTIO_FLAGS_SLUG);
  await listExistingOptions(ATTIO_CONFIG_SLUG);
  await createMissingOptions(ATTIO_FLAGS_SLUG, [...FLAG_KEYS]);
}

async function upsertCompany(org, featureFlags, configFlags) {
  await createMissingOptions(ATTIO_FLAGS_SLUG, featureFlags);
  await createMissingOptions(ATTIO_CONFIG_SLUG, configFlags);

  const values = {
    domains: [org.domain],
    [ATTIO_FLAGS_SLUG]: featureFlags,
    [ATTIO_CONFIG_SLUG]: configFlags,
  };
  if (org.name) {
    values.name = org.name;
  }

  return attioFetch(
    `https://api.attio.com/v2/objects/companies/records?matching_attribute=domains`,
    { method: "PUT", body: JSON.stringify({ data: { values } }) },
  );
}

async function main() {
  console.log("=== LD organizations → Attio companies ===");
  console.log(`LIMIT=${LIMIT ?? "all"} DRY_RUN=${DRY_RUN}`);

  if (!DRY_RUN) await bootstrapOptions();

  const orgs = await listOrganizations(LIMIT);
  console.log(`Organizations to process: ${orgs.length}`);

  let ok = 0;
  let fail = 0;
  const samples = [];

  for (let i = 0; i < orgs.length; i++) {
    const org = orgs[i];
    try {
      const items = await evaluateOrg(org);
      const { featureFlags, configFlags } = extractFlags(items);

      if (samples.length < 5) {
        samples.push({ org, featureFlags, configFlags });
      }

      if (!DRY_RUN) {
        await upsertCompany(org, featureFlags, configFlags);
        await sleep(120);
      }

      ok += 1;
      if ((i + 1) % 10 === 0 || i === orgs.length - 1) {
        console.log(
          `  [${i + 1}/${orgs.length}] ok=${ok} fail=${fail} features=${featureFlags.length} configs=${configFlags.length}`,
        );
      }
    } catch (err) {
      fail += 1;
      console.error(`  FAIL #${i + 1}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log("\n=== Samples ===");
  for (let sIdx = 0; sIdx < samples.length; sIdx++) {
    const s = samples[sIdx];
    console.log(`\nSample ${sIdx + 1}`);
    console.log(
      `  flags (${s.featureFlags.length}): ${s.featureFlags.join(", ") || "(none)"}`,
    );
    console.log(
      `  configs (${s.configFlags.length}): ${s.configFlags.join(", ") || "(none)"}`,
    );
  }

  console.log(`\nDone. ok=${ok} fail=${fail}${DRY_RUN ? " (dry run)" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
