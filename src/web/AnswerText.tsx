import type { ReactNode } from "react";

/**
 * Safe renderer for model output (SECURITY §7.3, §12 #1). Everything becomes React text: raw HTML is shown as text,
 * markdown images are dropped, markdown links keep only their label (the model never gets to link anywhere), and
 * [n] markers become citation buttons. Supports paragraphs, bullet/numbered lists, headings, bold, italic and code.
 */

const LIST_ITEM = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/;
const ORDERED = /^\s*\d{1,3}[.)]\s+/;
const HEADING = /^\s{0,3}#{1,4}\s+/;
// Order matters: images and links before citations, bold before italic.
// Link targets may contain one level of parentheses, e.g. javascript:alert(1).
const INLINE =
  /(!\[[^\]\n]{0,200}\]\((?:[^()\n]|\([^()\n]{0,100}\)){0,500}\)|\[[^\]\n]{1,200}\]\((?:[^()\n]|\([^()\n]{0,100}\)){0,500}\)|\[\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*\]|\*\*[^*\n]{1,500}\*\*|__[^_\n]{1,500}__|\*[^*\n]{1,500}\*|`[^`\n]{1,300}`)/g;

export function citationNumbers(token: string): number[] {
  const out: number[] = [];
  for (const part of token.slice(1, -1).split(/[,;]/)) {
    const [a, b] = part.split(/[–-]/).map((x) => Number(x.trim()));
    if (b === undefined) out.push(a!);
    else for (let i = a!; i <= Math.min(b, a! + 20); i++) out.push(i);
  }
  return out;
}

interface Props {
  text: string;
  /** Source numbers that exist; other [n] stay plain text (a draft mid-stream can cite before validation). */
  sourceNumbers: Set<number>;
  onCite: (n: number, el: HTMLElement) => void;
}

export function AnswerText({ text, sourceNumbers, onCite }: Props) {
  const inline = (s: string, key: string): ReactNode[] =>
    s.split(INLINE).map((part, i) => {
      const k = `${key}.${i}`;
      if (!part) return null;
      if (part.startsWith("![")) return null; // images never render (zero-click exfiltration)
      if (/^\[[^\]]+\]\(/.test(part)) return part.slice(1, part.indexOf("]")); // link → label only
      if (/^\[\d/.test(part)) {
        const nums = citationNumbers(part);
        if (!nums.every((n) => sourceNumbers.has(n))) return part;
        return (
          <span key={k} className="whitespace-nowrap">
            {nums.map((n) => (
              <button
                key={n}
                type="button"
                onClick={(e) => onCite(n, e.currentTarget)}
                aria-label={`Source ${n}`}
                className="mx-0.5 inline-flex min-w-[1.5em] -translate-y-px items-center justify-center rounded-control bg-accent-soft px-1.5 align-baseline text-caption leading-5 font-medium text-text transition-colors hover:outline-1 hover:outline-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {n}
              </button>
            ))}
          </span>
        );
      }
      if (part.startsWith("**") || part.startsWith("__")) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("*")) return <em key={k}>{part.slice(1, -1)}</em>;
      if (part.startsWith("`"))
        return (
          <code key={k} className="rounded bg-accent-soft px-1 text-small">
            {part.slice(1, -1)}
          </code>
        );
      return part;
    });

  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-3 leading-answer">
      {blocks.map((block, b) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (!lines.length) return null;
        if (lines.every((l) => LIST_ITEM.test(l))) {
          const ordered = lines.every((l) => ORDERED.test(l));
          const items = lines.map((l, i) => <li key={i}>{inline(l.replace(LIST_ITEM, ""), `${b}.${i}`)}</li>);
          return ordered ? (
            <ol key={b} className="list-decimal space-y-1 pl-6">
              {items}
            </ol>
          ) : (
            <ul key={b} className="list-disc space-y-1 pl-6">
              {items}
            </ul>
          );
        }
        return (
          <p key={b} className={HEADING.test(lines[0]!) ? "font-semibold" : undefined}>
            {lines.map((l, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {inline(l.replace(HEADING, ""), `${b}.${i}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
