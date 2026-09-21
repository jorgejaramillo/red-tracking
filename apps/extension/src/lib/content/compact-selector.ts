/**
 * Short, human-readable CSS selectors for gaze samples and AOIs.
 *
 * Strategy: `#id` when the id is unique and CSS-safe, otherwise a path of up to
 * four ancestors of the form `tag.class1.class2:nth-of-type(n)` verified with
 * `querySelectorAll(sel).length === 1`. Falls back to the best-effort path when
 * uniqueness cannot be reached within four levels.
 */

const MAX_LEVELS = 4;
const MAX_CLASSES = 2;
const MAX_LENGTH = 200;

const SAFE_IDENT = /^[A-Za-z_][\w-]*$/;

/** Build-generated class names (`css-1a2b3c`, `sc-Ax4Jm`, `_3kfj2x`): digits plus a long trailing token. */
function looksGenerated(s: string): boolean {
  return /\d/.test(s) && /(^|[-_])[0-9A-Za-z]{5,}$/.test(s);
}

export function compactSelector(el: Element): string {
  try {
    const doc = el.ownerDocument;
    const byId = idSelector(el, doc);
    if (byId) return byId;

    const parts: string[] = [];
    let cur: Element | null = el;
    let best = '';
    for (let level = 0; level < MAX_LEVELS && cur && !isRootLike(cur); level++) {
      parts.unshift(segment(cur));
      const sel = parts.join(' > ');
      best = sel;
      if (isUnique(doc, sel)) return cap(sel);

      // An ancestor with a unique id anchors the path early.
      const parent: Element | null = cur.parentElement;
      if (parent && !isRootLike(parent)) {
        const anchor = idSelector(parent, doc);
        if (anchor) {
          const anchored = `${anchor} > ${sel}`;
          if (isUnique(doc, anchored)) return cap(anchored);
        }
      }
      cur = parent;
    }
    return cap(best || el.tagName.toLowerCase());
  } catch {
    return el.tagName ? el.tagName.toLowerCase() : '*';
  }
}

function idSelector(el: Element, doc: Document): string | null {
  const id = el.getAttribute('id');
  if (!id || !SAFE_IDENT.test(id)) return null;
  const sel = `#${cssEscape(id)}`;
  return isUnique(doc, sel) ? sel : null;
}

function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  let seg = tag;
  const classes = usableClasses(el);
  for (const c of classes) seg += `.${cssEscape(c)}`;

  const parent = el.parentElement;
  if (parent) {
    let index = 0;
    let sameTag = 0;
    for (const sib of Array.from(parent.children)) {
      if (sib.tagName === el.tagName) {
        sameTag++;
        if (sib === el) index = sameTag;
      }
    }
    if (sameTag > 1 && index > 0) seg += `:nth-of-type(${index})`;
  }
  return seg;
}

function usableClasses(el: Element): string[] {
  const out: string[] = [];
  const list = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '';
  for (const raw of list.split(/\s+/)) {
    const c = raw.trim();
    if (!c || out.includes(c)) continue;
    if (c.includes(':') || c.includes('/') || c.includes('[') || c.includes(']')) continue;
    if (c.length > 20 && /[\d#]/.test(c)) continue;
    if (looksGenerated(c)) continue;
    out.push(c);
    if (out.length >= MAX_CLASSES) break;
  }
  return out;
}

function isUnique(doc: Document, sel: string): boolean {
  try {
    return doc.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

function isRootLike(el: Element): boolean {
  const tag = el.tagName;
  return tag === 'HTML' || tag === 'BODY';
}

function cap(sel: string): string {
  return sel.length > MAX_LENGTH ? sel.slice(0, MAX_LENGTH) : sel;
}

function cssEscape(s: string): string {
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  } catch {
    /* fall through */
  }
  return s.replace(/([^\w-])/g, '\\$1');
}
