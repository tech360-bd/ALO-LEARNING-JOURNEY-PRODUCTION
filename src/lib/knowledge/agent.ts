/**
 * Builds the knowledge section an agent receives in its system prompt.
 *
 * Why generate it instead of hand-writing a prompt: the prompt and the index
 * must never disagree. Every line below is derived from KNOWLEDGE_SOURCES, so
 * adding a source changes the agent's behaviour with no second edit — and a
 * source cannot be described as usable before it is marked as such.
 */

import { AGENT_GUIDANCE, KNOWLEDGE_SOURCES, knowledgeSummary, type KnowledgeSource } from "./sources";

/** One compact line per source: id — adoption — licence — what to say. */
export function sourceLines(sources: KnowledgeSource[] = KNOWLEDGE_SOURCES): string[] {
  return sources.map(
    (source) =>
      `- ${source.name} (${source.id}, ${source.kind}) — adoption: ${source.adoption}; licence: ${source.facts.spdx ?? "none stated"}. ${source.agentUse}`,
  );
}

/** Character budget used by the chat prompt; exported so the API can report it. */
export const KNOWLEDGE_PROMPT_BUDGET = 2500;

/**
 * The prompt block. `maxChars` (default = the chat budget) bounds it so it
 * cannot crowd out the operator's own instruction in a long chat; entries are
 * dropped whole from the end, never truncated mid-sentence. The API returns
 * this exact string, so `?prompt=1` always shows what the model really receives.
 */
export function knowledgePromptBlock(maxChars = KNOWLEDGE_PROMPT_BUDGET): string {
  const header = [
    "## Knowledge index (static, reviewed 2026-11-27)",
    "Use ONLY these sources when asked what has been added. Never claim an integration that is not listed as integrated/service.",
    "",
  ];
  const guidance = AGENT_GUIDANCE.map((entry) => `- ${entry.guidance}`);
  const lines = sourceLines();
  const summary = knowledgeSummary();

  const parts = [
    ...header,
    "Rules:",
    ...guidance,
    "",
    `Totals: ${summary.total} sources; integrated=${summary.integrated.join(", ") || "none"}; rejected=${summary.rejected.join(", ") || "none"}.`,
    "",
    "Sources:",
    ...lines,
  ];

  let text = "";
  for (const part of parts) {
    if (text.length + part.length + 1 > maxChars) break;
    text += part + "\n";
  }
  return text.trimEnd();
}

/** Markdown table row escaped so a `|` inside a sentence cannot break the table. */
function cell(text: string): string {
  return text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

/**
 * A deterministic answer for "which repos are added as knowledge?".
 * Chunked so a chat bubble is not a wall of text: totals, then rejected
 * sources with their reason, then a table of everything still in play.
 */
export function sourceReport(query?: string): string {
  const needle = query?.trim().toLowerCase() ?? "";
  const matched = needle
    ? KNOWLEDGE_SOURCES.filter(
        (source) => source.id === needle || source.id.includes(needle) || source.name.toLowerCase().includes(needle),
      )
    : KNOWLEDGE_SOURCES;

  const rows = (matched.length ? matched : KNOWLEDGE_SOURCES).map((source) => {
    const stars = source.facts.stars === null ? "—" : source.facts.stars.toLocaleString("en-US");
    const licence = source.facts.spdx ?? "none stated";
    return `| ${cell(source.name)} | ${source.adoption} | ${licence} | ${stars} | ${cell(source.mayUse)} |`;
  });

  const rejected = (matched.length ? matched : KNOWLEDGE_SOURCES)
    .filter((source) => source.adoption === "rejected")
    .map((source) => `- **${source.name}** — ${cell(source.mustNot)}`);

  const summary = knowledgeSummary();
  // A narrowed answer counts the narrowed set — a single-source reply that
  // still says "15 sources" is the kind of half-truth this index exists to stop.
  const shown = matched.length ? matched : KNOWLEDGE_SOURCES;
  const scope =
    query && matched.length === 1
      ? `1 source (licences checked 2026-11-27; ${summary.total} in the index)`
      : `${shown.length} sources (licences checked 2026-11-27)`;
  const showsIntegrated = shown.some((source) => source.adoption === "integrated");
  return [
    `Knowledge index: ${scope}.`,
    showsIntegrated
      ? `Integrated: ${summary.integrated.join(", ") || "none"}. Usable today: ${summary.usableToday.join(", ")}.`
      : "Integrated here: not this source — nothing from it is wired into the app.",
    "",
    "Rejected, with the reason (so it is not re-litigated):",
    ...(rejected.length ? rejected : ["- none"]),
    "",
    "| source | adoption | licence | ★ | what may be used |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
