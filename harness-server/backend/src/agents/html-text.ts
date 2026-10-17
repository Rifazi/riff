const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•' };

function decodeQuotedPrintable(s: string): Buffer {
  const unfolded = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const hex = unfolded.slice(i + 1, i + 3);
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(unfolded[i], 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function plain(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function rowsToLines(html: string): string {
  return html.replace(/<tr[^>]*>([\s\S]*?)<\/tr\s*>/gi, (_m, row: string) => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => plain(c[1]));
    return cells.some(Boolean) ? `\n| ${cells.join(' | ')} |\n` : '';
  });
}

export function htmlToText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const text = rowsToLines(body)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(tr|p|div|h[1-6]|ul|ol|table|pre|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function looksLikeMime(head: string): boolean {
  return /^(Date|From|Subject|MIME-Version|Content-Type):/im.test(head) && /MIME-Version:/i.test(head);
}

export function looksLikeHtml(head: string): boolean {
  return /^\s*(<!doctype html|<html|<\?xml)/i.test(head);
}

/** First text/html part of a MIME (MHTML) message, e.g. Confluence's "Word" export. */
export function mimeHtmlPart(raw: string): string | null {
  const boundary = raw.match(/boundary="?([^"\r\n;]+)"?/i)?.[1];
  const parts = boundary ? raw.split(`--${boundary}`) : [raw];
  for (const part of parts) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const headers = part.slice(0, split);
    if (!/content-type:\s*text\/html/i.test(headers)) continue;
    const content = part.slice(split).replace(/^\r?\n\r?\n/, '');
    const charset = headers.match(/charset="?([\w-]+)"?/i)?.[1] ?? 'utf-8';
    const encoding = headers.match(/content-transfer-encoding:\s*(\S+)/i)?.[1]?.toLowerCase();
    const bytes =
      encoding === 'quoted-printable' ? decodeQuotedPrintable(content)
      : encoding === 'base64' ? Buffer.from(content.replace(/\s+/g, ''), 'base64')
      : Buffer.from(content, 'latin1');
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return bytes.toString('utf8');
    }
  }
  return null;
}
