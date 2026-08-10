import { detectEncoding, detectBOM, stripEncodingDeclarations } from './chardet';

export interface HtmlBook {
  title: string;
  fullMarkdown: string;
  toc: { id: string; label: string; level: number; lineIndex: number }[];
}

function parseHtmlContent(raw: string, fileName: string): HtmlBook {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');

  // Remove script, style, boilerplate headers and metadata tags
  doc.querySelectorAll('script, style, noscript, svg, head, header.pg-header, #pg-header, #pg-footer').forEach(el => el.remove());

  const titleEl = doc.querySelector('title');
  let rawTitle = titleEl?.textContent?.trim() || '';
  if (rawTitle.includes('|')) rawTitle = rawTitle.split('|')[0].trim();
  const bookTitle = rawTitle || fileName.replace(/\.[^/.]+$/, '');

  const toc: { id: string; label: string; level: number; lineIndex: number }[] = [];
  let markdownLines: string[] = [`# ${bookTitle}`, ''];
  let currentLineIndex = 2;

  // Első pass: belső linkek szöveg → cél-id leképezése (pl. "CHAPTER I." → "chap01")
  // A linkek szövege rövidebb lehet a fejléc-szövegnél → prefix-illesztés használata
  const anchorLinks: { text: string; target: string }[] = [];
  doc.querySelectorAll('a[href^="#"]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const target = href.slice(1); // #chap01 → chap01
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (target && text) {
      anchorLinks.push({ text, target });
    }
  });

  function appendBlock(text: string) {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    markdownLines.push(trimmed);
    markdownLines.push('');
    currentLineIndex += 2;
  }

  const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'div', 'section', 'article', 'main', 'header', 'footer', 'table']);

  function traverse(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = node.textContent?.replace(/\s+/g, ' ').trim();
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
        // Prefix-illesztés: a link szövege rövidebb lehet (pl. "CHAPTER I." vs "CHAPTER I. Down the Rabbit-Hole")
        const matchingLink = anchorLinks.find(l => headerText.startsWith(l.text));
        const headerId = el.id || (matchingLink ? matchingLink.target : `html-h-${toc.length}`);
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
        // A linkeket markdown-formátumban őrizzük meg (pl. [szöveg](#chap01))
        function liToMarkdown(li: Element): string {
          let html = li.innerHTML || '';
          html = html.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${text.trim()}](${href})`);
          html = html.replace(/<[^>]+>/g, ' ');
          return html.replace(/\s+/g, ' ').trim();
        }
        const listMarkdown = items
          .map((li, idx) => {
            const itemText = liToMarkdown(li);
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

    // For container elements (div, section, article, etc.): if it contains no nested block tags, treat as a single paragraph block
    const hasChildBlock = Array.from(el.children).some(child => BLOCK_TAGS.has(child.tagName.toLowerCase()));
    if (!hasChildBlock) {
      const blockText = (el.textContent || '').trim();
      if (blockText) {
        appendBlock(blockText);
      }
      return;
    }

    // Recurse into child nodes for container elements that have nested blocks
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
