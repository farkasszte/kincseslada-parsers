import { detectEncoding, detectBOM, stripEncodingDeclarations } from './chardet';

export interface HtmlBook {
  title: string;
  fullMarkdown: string;
  toc: { id: string; label: string; level: number; lineIndex: number }[];
}

function parseHtmlContent(raw: string, fileName: string): HtmlBook {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');

  // Remove script, style, and metadata tags
  doc.querySelectorAll('script, style, noscript, svg, head').forEach(el => el.remove());

  const titleEl = doc.querySelector('title');
  const bookTitle = titleEl?.textContent?.trim() || fileName.replace(/\.[^/.]+$/, '');

  const toc: { id: string; label: string; level: number; lineIndex: number }[] = [];
  let markdownLines: string[] = [`# ${bookTitle}`, ''];
  let currentLineIndex = 2;

  function appendBlock(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    markdownLines.push(trimmed);
    markdownLines.push('');
    currentLineIndex += 2;
  }

  function traverse(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = (node.textContent || '').trim();
      if (txt) {
        appendBlock(txt);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // Skip hidden or non-content elements
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'head') return;

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      const headerText = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (headerText) {
        const prefix = '#'.repeat(level);
        const headerId = `html-h-${toc.length}`;
        toc.push({
          id: headerId,
          label: headerText,
          level,
          lineIndex: currentLineIndex
        });
        appendBlock(`${prefix} ${headerText}`);
      }
      return;
    }

    if (tag === 'p') {
      const pText = (el.textContent || '').trim();
      if (pText) {
        appendBlock(pText);
      }
      return;
    }

    if (tag === 'blockquote') {
      const bText = (el.textContent || '').trim();
      if (bText) {
        appendBlock(`> ${bText.replace(/\n/g, '\n> ')}`);
      }
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.querySelectorAll(':scope > li'));
      if (items.length > 0) {
        const listMarkdown = items
          .map((li, idx) => {
            const itemText = (li.textContent || '').trim();
            if (!itemText) return null;
            return tag === 'ol' ? `${idx + 1}. ${itemText}` : `- ${itemText}`;
          })
          .filter(Boolean)
          .join('\n');
        if (listMarkdown) {
          appendBlock(listMarkdown);
        }
        return;
      }
    }

    // Recurse into child nodes for container elements (div, section, main, body, article, table, etc.)
    Array.from(node.childNodes).forEach(child => traverse(child));
  }

  const rootNode = doc.body || doc.documentElement;
  if (rootNode) {
    traverse(rootNode);
  }

  const fullMarkdown = markdownLines.join('\n');
  return { title: bookTitle, fullMarkdown, toc };
}

export async function parseHtmlFile(file: File): Promise<HtmlBook> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const bom = detectBOM(bytes);
  let raw: string;
  if (bom) {
    raw = new TextDecoder(bom.encoding).decode(bytes.slice(bom.strip));
  } else {
    const detected = detectEncoding(bytes);
    raw = detected.text;
  }

  raw = stripEncodingDeclarations(raw);

  try {
    return parseHtmlContent(raw, file.name);
  } catch (e) {
    console.warn('[HTML] parseHtmlContent failed, fallback to raw text:', e);
    const stripped = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = file.name.replace(/\.[^/.]+$/, '');
    return {
      title,
      fullMarkdown: stripped || `# ${title}\n\nA dokumentum nem tartalmaz kinyerhető szöveges tartalmat.`,
      toc: [],
    };
  }
}
