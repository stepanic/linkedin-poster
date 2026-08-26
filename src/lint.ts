// Voice linter.
//
// The point of automating publishing is not to publish faster, it is to publish
// the same text you would have written by hand. The tells below are the ones
// that give away machine-written prose, and an em-dash slipping into a post is
// worse than no automation at all — so dashes are a hard block, not a warning.
//
// A hyphen is NOT a dash: "read-only tier" and "two-day sprint" are correct and
// must never be flagged. Only U+2014 and U+2013 are errors.

export type Severity = "error" | "warning";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Byte offset of the first occurrence, for pointing at the spot. */
  index?: number;
  excerpt?: string;
}

/** LinkedIn rejects commentary longer than this. */
export const MAX_COMMENTARY = 3000;

const EM_DASH = "—";
const EN_DASH = "–";

function excerptAround(text: string, index: number, width = 40): string {
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + width);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\n/g, " ") + (end < text.length ? "…" : "");
}

export function lint(text: string): Finding[] {
  const findings: Finding[] = [];

  const emIndex = text.indexOf(EM_DASH);
  if (emIndex !== -1) {
    findings.push({
      rule: "no-em-dash",
      severity: "error",
      message: "Em-dash (—) found. Use a comma, a full stop, or a plain hyphen.",
      index: emIndex,
      excerpt: excerptAround(text, emIndex),
    });
  }

  const enIndex = text.indexOf(EN_DASH);
  if (enIndex !== -1) {
    findings.push({
      rule: "no-en-dash",
      severity: "error",
      message: "En-dash (–) found. Use a plain hyphen or rewrite the range.",
      index: enIndex,
      excerpt: excerptAround(text, enIndex),
    });
  }

  if (text.length > MAX_COMMENTARY) {
    findings.push({
      rule: "max-length",
      severity: "error",
      message: `Post is ${text.length} characters; LinkedIn accepts at most ${MAX_COMMENTARY}.`,
    });
  }

  if (text.trim().length === 0) {
    findings.push({ rule: "empty", severity: "error", message: "Post text is empty." });
  }

  // Markdown that LinkedIn renders literally. These are warnings rather than
  // errors: a stray asterisk in a sentence is not automatically a mistake.
  const bold = text.match(/\*\*[^*\n]+\*\*/);
  if (bold) {
    findings.push({
      rule: "no-markdown-bold",
      severity: "warning",
      message: `LinkedIn shows the asterisks literally: ${bold[0]}`,
      index: bold.index,
    });
  }

  const link = text.match(/\[[^\]\n]+\]\([^)\n]+\)/);
  if (link) {
    findings.push({
      rule: "no-markdown-link",
      severity: "warning",
      message: `Markdown links do not render on LinkedIn; paste the bare URL instead: ${link[0]}`,
      index: link.index,
    });
  }

  const heading = text.match(/^#{1,6}\s+\S/m);
  if (heading) {
    findings.push({
      rule: "no-markdown-heading",
      severity: "warning",
      message: "Markdown headings render as literal hash marks. Use a blank line instead.",
      index: heading.index,
    });
  }

  const bullet = text.match(/^\s*[-*]\s+\S/m);
  if (bullet) {
    findings.push({
      rule: "markdown-bullets",
      severity: "warning",
      message: "Bullet syntax stays literal. LinkedIn has no lists; blank lines are the only structure.",
      index: bullet.index,
    });
  }

  return findings;
}

export function errorsOf(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "error");
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((f) => {
      const head = `[${f.severity}] ${f.rule}: ${f.message}`;
      return f.excerpt ? `${head}\n    ${f.excerpt}` : head;
    })
    .join("\n");
}
