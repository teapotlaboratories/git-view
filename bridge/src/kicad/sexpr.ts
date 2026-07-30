/**
 * S-expression reader for KiCad files (ADR-038).
 *
 * KiCad 6+ stores schematics and boards as s-expressions, and — importantly — stores them *completely*:
 * symbol definitions, footprints, pad-level net assignments and filled zones are all inline. So parsing
 * the file is the whole job; no KiCad binary is needed to know what is on the sheet.
 *
 * Deliberately a plain reader, not a schema: it returns nested arrays and lets each caller pick out what
 * it needs. KiCad's grammar shifts between versions, and a reader that only knows how to nest is immune
 * to fields being added around it.
 */

/** A node is either an atom (string/number) or a list whose head is conventionally the tag. */
export type SNode = string | number | SNode[];

/** True when `n` is a list tagged `tag` — the shape nearly every lookup wants. */
export function isList(n: SNode | undefined, tag?: string): n is SNode[] {
  return Array.isArray(n) && (tag === undefined || n[0] === tag);
}

/** Direct children of `n` tagged `tag`. Not recursive: KiCad nests the same tag at several depths. */
export function children(n: SNode[], tag: string): SNode[][] {
  return n.filter((c): c is SNode[] => isList(c, tag));
}

/** First direct child tagged `tag`, or undefined. */
export function child(n: SNode[], tag: string): SNode[] | undefined {
  return children(n, tag)[0];
}

/** Numeric args of the first `tag` child — `(at 12.7 -5.08 90)` → `[12.7, -5.08, 90]`. */
export function nums(n: SNode[], tag: string): number[] {
  const c = child(n, tag);
  return c ? c.slice(1).filter((v): v is number => typeof v === "number") : [];
}

/** Every list tagged `tag` anywhere beneath `n`, depth-first. */
export function descendants(n: SNode[], tag: string): SNode[][] {
  const out: SNode[][] = [];
  const walk = (node: SNode[]): void => {
    for (const c of node) {
      if (!Array.isArray(c)) continue;
      if (c[0] === tag) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

/**
 * Parse a KiCad s-expression document into one root list.
 *
 * Handles the three token kinds KiCad emits: bare symbols, quoted strings (with `\"` and `\\` escapes),
 * and numbers. A bare token that looks numeric becomes a number — coordinates are the overwhelming
 * majority of atoms and every caller would otherwise convert them itself.
 */
export function parseSexpr(text: string): SNode[] {
  let i = 0;
  const n = text.length;

  const skipWs = (): void => {
    while (i < n) {
      const c = text[i]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else break;
    }
  };

  const readString = (): string => {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = text[i]!;
      if (c === "\\") {
        // KiCad escapes only the quote and the backslash itself; anything else passes through as-is,
        // which matters for Windows paths in (model ...) refs.
        const next = text[i + 1];
        out += next === '"' || next === "\\" ? next : `\\${next ?? ""}`;
        i += 2;
        continue;
      }
      if (c === '"') { i++; return out; }
      out += c;
      i++;
    }
    throw new Error("unterminated string in s-expression");
  };

  const readAtom = (): string | number => {
    const start = i;
    while (i < n) {
      const c = text[i]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "(" || c === ")") break;
      i++;
    }
    const raw = text.slice(start, i);
    // Only treat it as a number if the WHOLE token is one: layer names like "1.27mm" and refdes like
    // "R12" must stay strings, and Number("") is 0, which would silently swallow a parse slip.
    if (raw !== "" && Number.isFinite(Number(raw)) && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) {
      return Number(raw);
    }
    return raw;
  };

  const readList = (): SNode[] => {
    i++; // opening paren
    const out: SNode[] = [];
    for (;;) {
      skipWs();
      if (i >= n) throw new Error("unterminated list in s-expression");
      const c = text[i]!;
      if (c === ")") { i++; return out; }
      if (c === "(") { out.push(readList()); continue; }
      out.push(c === '"' ? readString() : readAtom());
    }
  };

  skipWs();
  if (text[i] !== "(") throw new Error("s-expression must start with '('");
  const root = readList();
  skipWs();
  return root;
}
