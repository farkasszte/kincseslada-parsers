// kincseslada – PDB/PalmDoc ebook format parser
// Copyright (C) 2025  Farkas Gergely
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Based on Calibre's PDB parser (GPL v3):
//   https://github.com/kovidgoyal/calibre/blob/master/src/calibre/ebooks/pdb/
// Modified by Farkas Gergely for browser-based TypeScript.

export interface PdbBook {
  title: string;
  author: string;
  htmlContent: string;
  toc: { id: string; label: string; level: number }[];
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new DecompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const buffer = data.buffer instanceof ArrayBuffer 
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : new Uint8Array(data).buffer;
  writer.write(buffer);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function decompressPalmdoc(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if (b >= 0xc0) {
      out.push(0x20);
      out.push(b ^ 0x80);
    } else if (b >= 0x80) {
      const code = (b << 8) | data[i++];
      const len = (code & 0x0007) + 3;
      const dist = (code >> 3) & 0x07ff;
      const start = out.length - dist;
      for (let k = 0; k < len; k++) out.push(out[start + k]);
    } else if (b >= 0x01 && b <= 0x08) {
      for (let k = 0; k < b && i < data.length; k++) out.push(data[i++]);
    } else {
      out.push(b);
    }
  }
  return new Uint8Array(out);
}

function pmlToHtml(pml: string, images: Record<string, string> = {}): string {
  let html = pml
    .replace(/\\(C)(\d)="([^"]*)"/g, (_, __, level, title) => `<h${Math.min(+level + 1, 6)}>${title}</h${+level + 1}>`)
    .replace(/\\(X)(\d)([^\\]*)\\X\d/g, (_, __, ___, text) => `<p>${text.trim()}</p>`)
    .replace(/\\(x)([^\\]*)\\x/g, (_, __, text) => `<p>${text.trim()}</p>`)
    .replace(/\\B/g, '<b>').replace(/\\b/g, '</b>')
    .replace(/\\I/g, '<i>').replace(/\\i/g, '</i>')
    .replace(/\\U/g, '<u>').replace(/\\u/g, '</u>')
    .replace(/\\S/g, '<strike>').replace(/\\s/g, '</strike>')
    .replace(/\\Q="([^"]*)"/g, '<a href="$1">$1</a>')
    .replace(/\\V\d+/g, '<span>')
    .replace(/\\v/g, '</span>')
    .replace(/\\([a-z])/g, '')
    .replace(/\\/g, '');

  Object.entries(images).forEach(([name, dataUri]) => {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    html = html.replace(re, `![${name}](${dataUri})`);
  });

  if (Object.keys(images).length) {
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" style="max-width:100%;height:auto" />`);
  }

  html = html.replace(/\n{3,}/g, '\n\n');
  const lines = html.split('\n').map(l => l.trim()).filter(Boolean);
  return '<html><body>' + lines.join('<br/>\n') + '</body></html>';
}

function readSection(data: Uint8Array, numSections: number, idx: number): Uint8Array {
  const off = 78 + idx * 8;
  const start = (data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];
  const end = idx === numSections - 1
    ? data.length
    : ((data[off + 8] << 24) | (data[off + 9] << 16) | (data[off + 10] << 8) | data[off + 11]);
  return data.slice(start, end);
}

function readPdbHeader(data: Uint8Array) {
  const decoder = new TextDecoder('ascii');
  return {
    title: decoder.decode(data.slice(0, 32)).replace(/\0/g, '').trim(),
    identity: decoder.decode(data.slice(60, 68)),
    numSections: (data[76] << 8) | data[77],
  };
}

export async function parsePdbFile(file: File): Promise<PdbBook> {
  const buffer = await file.arrayBuffer();
  const data = new Uint8Array(buffer);
  const hdr = readPdbHeader(data);
  const decoderCP1252 = new TextDecoder('windows-1252');

  const sections: Uint8Array[] = [];
  for (let i = 0; i < hdr.numSections; i++) sections.push(readSection(data, hdr.numSections, i));

  if (hdr.identity === 'TEXtREAd' || hdr.identity === 'TEXTTeal' || hdr.identity.startsWith('TEXT')) {
    const compression = (sections[0] && sections[0].length >= 2) ? ((sections[0][0] << 8) | sections[0][1]) : 2;
    const numRecords = (sections[0] && sections[0].length >= 10) ? ((sections[0][8] << 8) | sections[0][9]) : sections.length - 1;
    let fullText = '';
    for (let i = 1; i <= numRecords && i < sections.length; i++) {
      try {
        const sec = compression === 2 ? decompressPalmdoc(sections[i]) : sections[i];
        fullText += decoderCP1252.decode(sec);
      } catch {
        fullText += decoderCP1252.decode(sections[i]);
      }
    }
    const escaped = fullText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { title: hdr.title, author: '', htmlContent: `<html><body><pre>${escaped}</pre></body></html>`, toc: [] };
  }

  if (hdr.identity === 'PNRdPPrs' || hdr.identity === 'PNPdPPrs') {
    const r0 = sections[0];
    const headerSize = r0.length;
    let compression: number, nonTextOffset: number;
    let chapterCount = 0, chapterOffset = 0;
    if (headerSize === 132) {
      compression = (r0[0] << 8) | r0[1];
      nonTextOffset = (r0[12] << 8) | r0[13];
      chapterCount = (r0[14] << 8) | r0[15];
      chapterOffset = (r0[32] << 8) | r0[33];
    } else if (headerSize === 202 || headerSize === 116) {
      compression = 2;
      nonTextOffset = (r0[8] << 8) | r0[9];
    } else {
      throw new Error(`Ismeretlen eReader header méret: ${headerSize}`);
    }

    const numTextPages = nonTextOffset - 1;
    const metadataOffset = headerSize === 132 ? (r0[44] << 8) | r0[45] : -1;
    const hasMetadata = headerSize === 132 ? (r0[24] << 8) | r0[25] : 0;

    let metadata = { title: hdr.title, author: 'Ismeretlen szerző' };
    if (hasMetadata && metadataOffset > 0 && metadataOffset < sections.length) {
      const metaStr = decoderCP1252.decode(sections[metadataOffset]).split('\0');
      metadata = {
        title: metaStr[0] || hdr.title,
        author: metaStr[1] || 'Ismeretlen szerző',
      };
    }

    const images: Record<string, string> = {};
    if (headerSize === 132) {
      const imageDataOffset = (r0[40] << 8) | r0[41];
      const numImagePages = metadataOffset > imageDataOffset ? metadataOffset - imageDataOffset : 0;
      for (let i = 0; i < numImagePages && imageDataOffset + i < sections.length; i++) {
        const sec = sections[imageDataOffset + i];
        const marker = new TextDecoder('ascii').decode(sec.slice(0, 4));
        if (marker === 'PNG ' || marker === 'JPEG') {
          const name = new TextDecoder('ascii').decode(sec.slice(4, 36)).replace(/\0/g, '').trim();
          const imgData = sec.slice(62);
          const mime = marker === 'PNG ' ? 'image/png' : 'image/jpeg';
          const b64 = btoa(String.fromCharCode(...imgData));
          images[name] = `data:${mime};base64,${b64}`;
        }
      }
    } else {
      for (let i = nonTextOffset; i < sections.length; i++) {
        const sec = sections[i];
        const marker = new TextDecoder('ascii').decode(sec.slice(0, 4));
        if (marker === 'PNG ' || marker === 'JPEG') {
          const name = new TextDecoder('ascii').decode(sec.slice(4, 36)).replace(/\0/g, '').trim();
          const imgData = sec.slice(62);
          const mime = marker === 'PNG ' ? 'image/png' : 'image/jpeg';
          const b64 = btoa(String.fromCharCode(...imgData));
          images[name] = `data:${mime};base64,${b64}`;
        }
      }
    }

    let pml = '';
    for (let i = 1; i <= numTextPages && i < sections.length; i++) {
      let sec = sections[i];
      if (headerSize !== 132) {
        sec = new Uint8Array(sec.map(b => b ^ 0xA5));
      }
      if (compression === 2) {
        pml += decoderCP1252.decode(decompressPalmdoc(sec));
      } else if (compression === 10) {
        try {
          pml += decoderCP1252.decode(await inflateZlib(sec));
        } catch {
          pml += decoderCP1252.decode(sec);
        }
      } else {
        pml += decoderCP1252.decode(sec);
      }
    }

    const html = pmlToHtml(pml, images);
    const toc: { id: string; label: string; level: number }[] = [];
    if (chapterCount > 0 && chapterOffset > 0 && chapterOffset < sections.length) {
      for (let i = 0; i < chapterCount && chapterOffset + i < sections.length; i++) {
        const raw = sections[chapterOffset + i];
        const nameBytes = raw.subarray(4);
        const nullIdx = nameBytes.findIndex(b => b === 0);
        const name = decoderCP1252.decode(nullIdx >= 0 ? nameBytes.slice(0, nullIdx) : nameBytes).trim();
        if (name) {
          toc.push({ id: `ch-${i}`, label: name, level: 1 });
        }
      }
    }
    return { title: metadata.title, author: metadata.author, htmlContent: html, toc };
  }

  if (hdr.identity === 'zTXTGPlm') {
    let fullText = '';
    for (let i = 1; i < sections.length; i++) {
      try {
        fullText += decoderCP1252.decode(await inflateZlib(sections[i]));
      } catch {
        fullText += decoderCP1252.decode(sections[i]);
      }
    }
    const escaped = fullText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { title: hdr.title, author: '', htmlContent: `<html><body><pre>${escaped}</pre></body></html>`, toc: [] };
  }

  // Fallback for unknown PDB format variants: extract raw/compressed text records
  if (sections.length > 1) {
    let fallbackText = '';
    for (let i = 1; i < sections.length; i++) {
      try {
        const sec = decompressPalmdoc(sections[i]);
        fallbackText += decoderCP1252.decode(sec);
      } catch {
        fallbackText += decoderCP1252.decode(sections[i]);
      }
    }
    if (fallbackText.trim()) {
      const escaped = fallbackText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return { title: hdr.title || file.name.replace(/\.pdb$/i, ''), author: '', htmlContent: `<html><body><pre>${escaped}</pre></body></html>`, toc: [] };
    }
  }

  throw new Error(`Nem támogatott PDB formátum: ${hdr.identity}. Támogatott: TEXtREAd (PalmDoc), PNRdPPrs/PNPdPPrs (eReader), zTXTGPlm (zTXT)`);
}
