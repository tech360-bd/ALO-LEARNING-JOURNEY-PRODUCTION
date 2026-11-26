// ALO Learning Journey — Super Admin natural-language intent parser.
// Rule-based (Bengali + English) so routing works even when no AI model
// is available. The AI is used for free-form answers, never for deciding
// whether a destructive action runs — that decision is deterministic here.

export type IntentKind =
  | "health_check"
  | "scan_errors"
  | "fix_errors"
  | "switch_provider"
  | "announce"
  | "analytics"
  | "backup"
  | "providers_status"
  | "chat";

export interface ParsedIntent {
  kind: IntentKind;
  /** Extracted entities (provider id, announcement text, ...). */
  entities: Record<string, string>;
  /** Confidence 0..1 (rule match strength). */
  confidence: number;
  /** Human-readable explanation of the routing decision. */
  reason: string;
}

const PROVIDER_IDS = ["groq", "llm7", "opencode", "openrouter", "omniroute", "local-ollama", "ollama"];

function has(text: string, ...terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

export function parseIntent(raw: string): ParsedIntent {
  const text = raw.toLowerCase().trim();

  const providerMatch = PROVIDER_IDS.find((p) => text.includes(p));

  if (has(text, "health", "স্বাস্থ্য", "সিস্টেম চেক", "system check", "status check", "system status", "স্ট্যাটাস")) {
    return { kind: "health_check", entities: {}, confidence: 0.9, reason: "Matched health/status keywords." };
  }
  // Fix before scan: "fix the errors" / "ভুলগুলো ঠিক করুন" must not be
  // captured by the scan keywords first.
  if (has(text, "fix", "ঠিক কর", "সংশোধন", "repair", "সারাও", "auto-fix", "autofix")) {
    return { kind: "fix_errors", entities: {}, confidence: 0.85, reason: "Matched fix/repair keywords." };
  }
  if (has(text, "scan", "স্ক্যান", "error", "ত্রুটি", "ভুল", "bug", "বাগ", "check errors", "find errors", "ত্রুটি খুঁজ")) {
    return { kind: "scan_errors", entities: {}, confidence: 0.85, reason: "Matched error-scan keywords." };
  }
  if (has(text, "switch", "বদল", "change provider", "use groq", "use openrouter", "provider", "প্রোভাইডার", "omni")) {
    return {
      kind: providerMatch ? "switch_provider" : "providers_status",
      entities: providerMatch ? { provider: providerMatch } : {},
      confidence: providerMatch ? 0.9 : 0.7,
      reason: providerMatch ? `Matched provider "${providerMatch}" with switch keywords.` : "Matched provider keywords without a specific provider.",
    };
  }
  if (has(text, "announce", "ঘোষণা", "notice", "নোটিশ")) {
    // Announcement text = everything after the separator following the
    // keyword ("announce: …", "ঘোষণা দিন: …"). No separator → executor asks.
    const m = raw.match(/(?:announce[ment]?|ঘোষণা|notice|নোটিশ)[^:]*[:\-–—]\s*(.+)/i);
    const after = m ? m[1].trim().slice(0, 500) : "";
    return { kind: "announce", entities: after ? { text: after } : {}, confidence: 0.8, reason: "Matched announcement keywords." };
  }
  if (has(text, "analytics", "অ্যানালিটিক্স", "views", "ভিউ", "stats", "পরিসংখ্যান", "report")) {
    return { kind: "analytics", entities: {}, confidence: 0.8, reason: "Matched analytics keywords." };
  }
  if (has(text, "backup", "ব্যাকআপ", "back up")) {
    return { kind: "backup", entities: {}, confidence: 0.85, reason: "Matched backup keywords." };
  }
  if (has(text, "which provider", "কোন প্রোভাইডার", "active provider", "সক্রিয়")) {
    return { kind: "providers_status", entities: {}, confidence: 0.8, reason: "Matched active-provider question." };
  }

  return { kind: "chat", entities: {}, confidence: 0.5, reason: "No system-action keywords matched; treating as free-form chat." };
}
