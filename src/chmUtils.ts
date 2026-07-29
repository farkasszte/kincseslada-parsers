import { detectEncoding } from './chardet';

function resolveChmPath(reader: any, basePath: string, ref: string): string {
  return reader.resolvePath(basePath, ref);
}

export async function resolveImage(reader: any, src: string, basePath: string, cache: Map<string, string>): Promise<string> {
  if (!src || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http://') || src.startsWith('https://')) {
    return src;
  }
  const key = src;
  if (cache.has(key)) return cache.get(key)!;

  let resolved = resolveChmPath(reader, basePath, src);
  let bytes = reader.getFile(resolved);
  if (!bytes) {
    const alt = resolved.replace(/\\/g, '/').replace(/^\/+/, '');
    bytes = reader.getFile(alt);
    if (bytes) resolved = alt;
  }
  if (!bytes) {
    cache.set(key, src);
    return src;
  }

  const ext = resolved.split('.').pop()?.toLowerCase() || 'png';
  const mime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  };
  try {
    const blob = new Blob([bytes], { type: mime[ext] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    cache.set(key, url);
    return url;
  } catch {
    cache.set(key, src);
    return src;
  }
}

const CHM_ENCODING_FALLBACKS = ['utf-8', 'windows-1252', 'cp1251', 'iso-8859-1', 'latin1'];

export function decodeChmText(rawBytes: Uint8Array): string {
  for (const enc of CHM_ENCODING_FALLBACKS) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(rawBytes);
    } catch {}
  }
  const detected = detectEncoding(rawBytes);
  return detected.text;
}

export function cleanupChmHtml(html: string): string {
  const parser = new DOMParser();
  let doc: Document;
  try {
    doc = parser.parseFromString(html, 'text/html');
  } catch {
    return html;
  }

  const body = doc.body;
  if (!body) return html;

  const tables = body.querySelectorAll('table');
  for (const table of tables) {
    const links = table.querySelectorAll('a');
    let navLinks = 0;
    let navImages = 0;
    for (const a of links) {
      const href = (a.getAttribute('href') || '').toLowerCase();
      const img = a.querySelector('img');
      if (href && img) {
        const alt = (img.getAttribute('alt') || '').toLowerCase();
        if (alt.includes('previous') || alt.includes('prev') ||
            alt.includes('next') || alt.includes('forward') ||
            href.includes('prev') || href.includes('next') ||
            href.includes('back') || href.includes('forward')) {
          navLinks++;
          if (img) navImages++;
        }
      }
    }
    if (navLinks > 0 && (navImages / links.length) > 0.3) {
      table.remove();
    }
  }

  const directTables: HTMLTableElement[] = [];
  for (let i = 0; i < body.children.length; i++) {
    const child = body.children[i];
    if (child instanceof HTMLTableElement && child.closest('table') === child) {
      directTables.push(child);
    }
  }
  if (directTables.length === 1 && body.children.length === 1) {
    const cells = directTables[0].querySelectorAll('td');
    if (cells.length === 1) {
      const innerHtml = cells[0].innerHTML;
      const innerDoc = parser.parseFromString(`<div>${innerHtml}</div>`, 'text/html');
      body.innerHTML = innerDoc.body?.innerHTML || innerHtml;
    }
  }

  for (const tag of ['object', 'embed', 'applet']) {
    const els = body.querySelectorAll(tag);
    for (const el of els) el.remove();
  }

  return doc.documentElement?.outerHTML || html;
}
