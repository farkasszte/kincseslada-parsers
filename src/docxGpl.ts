export interface DocxRunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vertAlign?: string;
  fontSize?: string;
  fontFamily?: string;
  color?: string;
  highlight?: string;
  bg?: string;
}

export interface DocxStyle {
  type: 'paragraph' | 'character' | 'numbering' | 'table';
  basedOn?: string;
  rPr?: DocxRunProps;
  pPr?: {
    spacing?: { line?: string; before?: string; after?: string; lineRule?: string };
    ind?: { left?: string; right?: string; firstLine?: string; hanging?: string };
    jc?: string;
    numPr?: { numId?: string; ilvl?: string };
  };
}

export class DocxStyleResolver {
  private styles: Map<string, DocxStyle> = new Map();
  private docDefaults: { rPr?: DocxRunProps; pPr?: DocxStyle['pPr'] } = {};
  private cache: Map<string, DocxStyle> = new Map();

  load(stylesDoc: Document): void {
    const defaultRPr = stylesDoc.querySelector('w\\:docDefaults w\\:rPrDefault w\\:rPr');
    if (defaultRPr) this.docDefaults.rPr = this.parseRPr(defaultRPr);
    const defaultPPr = stylesDoc.querySelector('w\\:docDefaults w\\:pPrDefault w\\:pPr');
    if (defaultPPr) this.docDefaults.pPr = this.parsePPr(defaultPPr);

    const styleEls = stylesDoc.querySelectorAll('w\\:style');
    for (const el of styleEls) {
      const id = el.getAttribute('w:styleId');
      if (!id) continue;
      const type = el.getAttribute('w:type') as DocxStyle['type'];
      const basedOn = el.querySelector('w\\:basedOn')?.getAttribute('w:val');
      const style: DocxStyle = { type, basedOn };
      const rPrEl = el.querySelector('w\\:rPr');
      if (rPrEl) style.rPr = this.parseRPr(rPrEl);
      const pPrEl = el.querySelector('w\\:pPr');
      if (pPrEl) style.pPr = this.parsePPr(pPrEl);
      this.styles.set(id, style);
    }
  }

  private parseRPr(el: Element): DocxRunProps {
    const r: DocxRunProps = {};
    const b = el.querySelector('w\\:b');
    if (b) r.bold = b.getAttribute('w:val') !== '0' && b.getAttribute('w:val') !== 'false';
    const i = el.querySelector('w\\:i');
    if (i) r.italic = i.getAttribute('w:val') !== '0' && i.getAttribute('w:val') !== 'false';
    const u = el.querySelector('w\\:u');
    if (u) r.underline = u.getAttribute('w:val') !== 'none';
    const s = el.querySelector('w\\:strike');
    if (s) r.strike = s.getAttribute('w:val') !== '0' && s.getAttribute('w:val') !== 'false';
    const va = el.querySelector('w\\:vertAlign');
    if (va) r.vertAlign = va.getAttribute('w:val') || '';
    const sz = el.querySelector('w\\:sz');
    if (sz) r.fontSize = sz.getAttribute('w:val') || '';
    const rf = el.querySelector('w\\:rFonts');
    if (rf) r.fontFamily = rf.getAttribute('w:ascii') || rf.getAttribute('w:hAnsi') || '';
    const c = el.querySelector('w\\:color');
    if (c) r.color = c.getAttribute('w:val') || '';
    const h = el.querySelector('w\\:highlight');
    if (h) r.highlight = h.getAttribute('w:val') || '';
    const shd = el.querySelector('w\\:shd');
    if (shd) r.bg = shd.getAttribute('w:fill') || '';
    return r;
  }

  private parsePPr(el: Element): DocxStyle['pPr'] {
    const p: DocxStyle['pPr'] = {};
    const jc = el.querySelector('w\\:jc');
    if (jc) p.jc = jc.getAttribute('w:val') || '';
    const spacing = el.querySelector('w\\:spacing');
    if (spacing) {
      p.spacing = {
        line: spacing.getAttribute('w:line') || undefined,
        before: spacing.getAttribute('w:before') || undefined,
        after: spacing.getAttribute('w:after') || undefined,
        lineRule: spacing.getAttribute('w:lineRule') || undefined,
      };
    }
    const ind = el.querySelector('w\\:ind');
    if (ind) {
      p.ind = {
        left: ind.getAttribute('w:left') || undefined,
        right: ind.getAttribute('w:right') || undefined,
        firstLine: ind.getAttribute('w:firstLine') || undefined,
        hanging: ind.getAttribute('w:hanging') || undefined,
      };
    }
    const numPr = el.querySelector('w\\:numPr');
    if (numPr) {
      p.numPr = {
        numId: numPr.querySelector('w\\:numId')?.getAttribute('w:val') || undefined,
        ilvl: numPr.querySelector('w\\:ilvl')?.getAttribute('w:val') || undefined,
      };
    }
    return p;
  }

  resolve(styleId: string | null, visited = new Set<string>()): DocxStyle {
    if (!styleId) return { type: 'paragraph' };
    if (visited.has(styleId)) return { type: 'paragraph' };
    visited.add(styleId);

    const cached = this.cache.get(styleId);
    if (cached) return cached;

    const style = this.styles.get(styleId);
    if (!style) return { type: 'paragraph' };

    let base: DocxStyle = { type: style.type };
    if (style.basedOn) {
      base = this.resolve(style.basedOn, visited);
    }

    const merged: DocxStyle = {
      type: style.type,
      rPr: { ...base.rPr, ...style.rPr },
      pPr: this.mergePPr(base.pPr, style.pPr),
    };
    this.cache.set(styleId, merged);
    return merged;
  }

  private mergePPr(base: DocxStyle['pPr'] = {}, override: DocxStyle['pPr'] = {}): DocxStyle['pPr'] {
    return {
      ...base,
      ...override,
      spacing: { ...base.spacing, ...override.spacing },
      ind: { ...base.ind, ...override.ind },
      numPr: { ...base.numPr, ...override.numPr },
    };
  }

  getDefaults(): DocxStyle {
    return {
      type: 'paragraph',
      rPr: { ...this.docDefaults.rPr },
      pPr: { ...this.docDefaults.pPr },
    };
  }

  mergeRunProps(...props: (DocxRunProps | undefined)[]): DocxRunProps {
    return Object.assign({}, ...props.filter(Boolean));
  }
}
