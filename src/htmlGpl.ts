import { detectEncoding, detectBOM, stripEncodingDeclarations } from './chardet';

export interface HtmlBook {
  title: string;
  fullMarkdown: string;
  toc: { id: string; label: string; level: number; lineIndex: number }[];
}

function parseHtmlContent(raw: string, fileName: string): HtmlBook {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');

  const titleEl = doc.querySelector('title');
  const bookTitle = titleEl?.textContent?.trim() || fileName.replace(/\.[^/.]+$/, '');

  const toc: { id: string; label: string; level: number; lineIndex: number }[] = [];
  let markdownText = `# ${bookTitle}\n\n`;
  let lineCount = 0;

  const bodyNodes = doc.body ? Array.from(doc.body.childNodes) : [];

  if (bodyNodes.length === 0) {
    markdownText += raw.replace(/<[^>]*>/g, ' ');
  } else {
    for (let i = 0; i < bodyNodes.length; i++) {
      try {
        const node = bodyNodes[i];
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const tag = el.tagName.toLowerCase();
          const elText = el.textContent?.trim() || '';

          if (!elText) continue;

          if (tag.startsWith('h') && tag.length === 2) {
            const level = parseInt(tag[1], 10) || 1;
            const prefix = '#'.repeat(level);
            markdownText += `${prefix} ${elText}\n\n`;
            toc.push({
              id: `html-h-${i}`,
              label: elText,
              level,
              lineIndex: lineCount
            });
          } else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
            markdownText += `${elText}\n\n`;
          } else if (tag === 'ul' || tag === 'ol') {
            const items = el.querySelectorAll('li');
            items.forEach(li => {
              if (li.textContent?.trim()) {
                markdownText += `- ${li.textContent.trim()}\n`;
              }
            });
            markdownText += '\n';
          } else if (tag === 'blockquote') {
            markdownText += `> ${elText}\n\n`;
          }
          lineCount++;
        }
      } catch (e) {
        console.warn('[HTML] skip node:', e);
      }
    }
  }

  return { title: bookTitle, fullMarkdown: markdownText, toc };
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
