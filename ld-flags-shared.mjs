/**
 * Shared LD → Attio flag lists & extraction.
 *
 * Client org→domain map lives in gitignored `org-domains.json`
 * (see `org-domains.example.json`). Do not hardcode customer names here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadOrgNameToDomain() {
  const file = path.join(__dirname, "org-domains.json");
  if (!fs.existsSync(file)) {
    console.warn(
      "org-domains.json missing — copy org-domains.example.json (gitignored; not for public repos)",
    );
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`org-domains.json unreadable: ${err.message}`);
    return {};
  }
}

export const FLAG_KEYS = new Set([
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

export const CONFIG_FLAG_KEYS = new Set([
  "custom-bot-name",
  "browser-recording-start-confirmation",
  "book-a-demo-links",
  "voice-agents-mode",
  "recording-confirmation-config",
  "share-auto-provision-domains",
  "feature-flags-opt-in",
]);

/** LD org name → Attio company domain (loaded from gitignored org-domains.json). */
export const ORG_NAME_TO_DOMAIN = loadOrgNameToDomain();

export function isWantedFlag(key) {
  return FLAG_KEYS.has(key) || key.endsWith("-notification-announcement");
}

export function extractFlags(items) {
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
          configFlags.push(`${key}=${subs.join("+")}`);
        }
      }
      continue;
    }

    if (typeof v === "string" || typeof v === "number") {
      const truncated =
        typeof v === "string" && v.length > 80 ? `${v.slice(0, 77)}...` : String(v);
      configFlags.push(`${key}=${truncated}`);
    }
  }

  return {
    featureFlags: [...new Set(featureFlags)].sort(),
    configFlags: [...new Set(configFlags)].sort(),
  };
}

export function domainForOrg(name, key) {
  if (name && ORG_NAME_TO_DOMAIN[name]) return ORG_NAME_TO_DOMAIN[name];
  // fallback: slug from name
  if (name) {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 40) + ".com"
    );
  }
  // last resort: synthetic domain from UUID (unique for matching)
  return `ld-org-${key.slice(0, 8)}.local`;
}
