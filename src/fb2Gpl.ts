import { detectEncoding, detectBOM, stripEncodingDeclarations } from './chardet';

type BinaryMap = Record<string, { mime: string; data: string }>;

export interface Fb2Section {
  title: string;
  id: string;
  htmlContent: string;
}

export interface Fb2Book {
  title: string;
  author: string;
  coverUrl?: string;
  sections: Fb2Section[];
}

function getImageDataUri(href: string, binaries: BinaryMap): string | null {
  const id = href.replace(/^#/, '');
  const bin = binaries[id];
  if (!bin) return null;
  return `data:${bin.mime};base64,${bin.data}`;
}

function convertFb2NodeToHtml(node: Node, binaries: BinaryMap, skipSections = false, skipTopTitle = false): string {
  let html = '';
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent || '';
      if (text.trim()) {
        html += text;
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tagName = el.tagName.toLowerCase();

      if (tagName === 'section' && skipSections) {
        return;
      }
      if (tagName === 'title' && skipTopTitle) {
        return;
      }

      switch (tagName) {
        case 'image': {
          const href = el.getAttribute('l:href') || el.getAttribute('xlink:href') || el.getAttribute('href') || '';
          const src = getImageDataUri(href, binaries);
          if (src) {
            html += `<img src="${src}" alt="" class="max-w-full h-auto my-4 mx-auto" loading="lazy" />`;
          }
          break;
        }
        case 'title':
          html += `<h2 class="text-xl font-bold my-4 border-b border-border/50 pb-2">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</h2>`;
          break;
        case 'p':
          html += `<p class="my-3 leading-relaxed text-justify">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</p>`;
          break;
        case 'subtitle':
          html += `<h3 class="text-lg font-semibold my-3">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</h3>`;
          break;
        case 'emphasis':
        case 'v':
          html += `<em class="italic">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</em>`;
          break;
        case 'strong':
          html += `<strong class="font-bold">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</strong>`;
          break;
        case 'epigraph':
          html += `<blockquote class="border-l-4 border-accent/60 pl-4 my-4 italic opacity-90">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</blockquote>`;
          break;
        case 'cite':
          html += `<div class="text-right text-xs opacity-75 mt-2">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</div>`;
          break;
        case 'empty-line':
          html += `<div class="h-4"></div>`;
          break;
        case 'poem':
        case 'stanza':
          html += `<div class="my-4 pl-6 border-l-2 border-primary/30">${convertFb2NodeToHtml(el, binaries, skipSections, false)}</div>`;
          break;
        default:
          html += convertFb2NodeToHtml(el, binaries, skipSections, false);
          break;
      }
    }
  });
  return html;
}

function flattenSections(parent: Element, result: Fb2Section[], binaries: BinaryMap, parentTitle?: string): void {
  const childSections = Array.from(parent.children).filter(
    (child: Element) => child.tagName.toLowerCase() === 'section'
  );

  if (childSections.length === 0) {
    return;
  }

  for (const sec of childSections) {
    const titleEl = sec.querySelector(':scope > title');
    const rawTitle = titleEl?.textContent?.trim() || '';
    const fullTitle = parentTitle && rawTitle ? `${parentTitle} - ${rawTitle}` : rawTitle || `${result.length + 1}. Fejezet`;
    const id = `sec-${result.length}`;

    // Pass skipTopTitle = true so section title isn't duplicated inside section html body
    const htmlContent = convertFb2NodeToHtml(sec, binaries, true, true);
    result.push({ title: fullTitle, id, htmlContent });

    flattenSections(sec, result, binaries, rawTitle);
  }
}

export async function parseFb2File(file: File): Promise<Fb2Book> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // 1. Detect BOM
  const bom = detectBOM(bytes);
  let text: string;
  if (bom) {
    text = new TextDecoder(bom.encoding).decode(bytes.slice(bom.strip));
  } else {
    // 2. Check XML encoding header declaration
    const asciiPrefix = new TextDecoder('ascii').decode(bytes.slice(0, 200));
    const encMatch = asciiPrefix.match(/<\?xml\b[^>]*encoding=["']([^"']+)["']/i);
    if (encMatch && encMatch[1]) {
      try {
        text = new TextDecoder(encMatch[1]).decode(bytes);
      } catch {
        text = detectEncoding(bytes).text;
      }
    } else {
      text = detectEncoding(bytes).text;
    }
  }

  text = stripEncodingDeclarations(text).replace(/^\uFEFF/, '').trim();

  const parser = new DOMParser();
  let xmlDoc = parser.parseFromString(text, 'text/xml');

  // Fallback to HTML parser if XML parser reports syntax error
  if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
    xmlDoc = parser.parseFromString(text, 'text/html');
  }

  // Extract title & author
  const titleEl = xmlDoc.querySelector('book-title');
  const title = titleEl?.textContent?.trim() || file.name.replace(/\.fb2$/i, '');

  const firstName = xmlDoc.querySelector('author > first-name')?.textContent?.trim() || '';
  const lastName = xmlDoc.querySelector('author > last-name')?.textContent?.trim() || '';
  const author = [firstName, lastName].filter(Boolean).join(' ') || 'Ismeretlen szerző';

  // Collect binary images
  const binaries: BinaryMap = {};
  xmlDoc.querySelectorAll('binary').forEach(b => {
    const id = b.getAttribute('id');
    if (id && b.textContent) {
      binaries[id] = {
        mime: b.getAttribute('content-type') || 'image/jpeg',
        data: b.textContent.trim().replace(/\s/g, '')
      };
    }
  });

  // Cover image handling
  let coverUrl: string | undefined;
  const coverImageEl = xmlDoc.querySelector('coverpage image');
  const coverHref = coverImageEl?.getAttribute('l:href') || coverImageEl?.getAttribute('xlink:href') || coverImageEl?.getAttribute('href');
  if (coverHref) {
    coverUrl = getImageDataUri(coverHref, binaries) || undefined;
  }

  // Parse body sections
  const sections: Fb2Section[] = [];

  if (coverUrl) {
    sections.push({
      title: 'Borító',
      id: 'cover',
      htmlContent: `<img src="${coverUrl}" alt="Borító" class="max-w-full h-auto mx-auto" />`
    });
  }

  const bodyEl = xmlDoc.querySelector('body');
  if (bodyEl) {
    flattenSections(bodyEl, sections, binaries);
  }

  if (sections.length === 0) {
    sections.push({
      title: title,
      id: 'sec-0',
      htmlContent: convertFb2NodeToHtml(xmlDoc.body || xmlDoc.documentElement, binaries) || '<p>A dokumentum nem tartalmaz olvasható fejezetet.</p>'
    });
  }

  return { title, author, coverUrl, sections };
}
