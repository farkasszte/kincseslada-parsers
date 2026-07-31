// kincseslada – LIT ebook format parser
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
// Based on Calibre's LIT parser (GPL v3):
//   https://github.com/kovidgoyal/calibre/blob/master/src/calibre/ebooks/lit/
// Modified by Farkas Gergely for browser-based TypeScript.

import { decompressBlock } from './lzx.js';
import { HTML_TAGS, HTML_TAG_ATTRS, OPF_TAGS, OPF_ATTRS } from './litMaps';

export interface LitBook {
  title: string;
  author: string;
  htmlContent: string;
  toc: { id: string; label: string; level: number }[];
}

const DESENCRYPT_GUID = '{67F6E4A2-60BF-11D3-8540-00C04F58C3CF}';
const LZXCOMPRESS_GUID = '{0A9007C6-4076-11D3-8789-0000F8105754}';
const CONTROL_TAG = 4;
const CONTROL_WINDOW_SIZE = 12;

function u32(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
}

function i32(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24));
}

function u16(data: Uint8Array, off: number): number {
  return data[off] | (data[off + 1] << 8);
}

function guidStr(data: Uint8Array, off: number): string {
  const g = (i: number, l: number) => Array.from(data.subarray(off + i, off + i + l)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return `{${g(0, 4)}-${g(4, 2)}-${g(6, 2)}-${g(8, 2)}${g(10, 2)}-${g(12, 4).toUpperCase()}}`;
}

function readEncInt(data: Uint8Array, pos: number): [number, number] {
  let val = 0;
  while (pos < data.length) {
    const b = data[pos++];
    val = (val << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [val, pos];
}

function readUtf8Char(data: Uint8Array, pos: number): [string, number] {
  if (pos >= data.length) return ['', pos];
  const b0 = data[pos];
  if (b0 < 0x80) return [String.fromCharCode(b0), pos + 1];
  try {
    const leading = [0, 0, 0xC0, 0xE0, 0xF0, 0xF8, 0xFC];
    let len = 0;
    for (let i = 6; i >= 2; i--) { if ((b0 & (0x80 >> (6 - i))) === leading[i]) { len = i; break; } }
    if (len >= 2 && pos + len <= data.length) {
      let code = b0 & (0x3F >> len);
      for (let i = 1; i < len; i++) code = (code << 6) | (data[pos + i] & 0x3f);
      return [String.fromCodePoint(code), pos + len];
    }
  } catch {}
  return [String.fromCharCode(b0), pos + 1];
}

class UnBinary {
  tagMap: (string | null)[];
  attrMap: Record<number, string>;
  tagAttrMap: (Record<number, string> | null)[];

  constructor(isOpf: boolean) {
    this.tagMap = isOpf ? OPF_TAGS : HTML_TAGS;
    this.tagAttrMap = isOpf ? [] : HTML_TAG_ATTRS;
    this.attrMap = isOpf ? OPF_ATTRS : {
      0x8010: 'tabindex', 0x8046: 'title', 0x804B: 'style', 0x804D: 'disabled',
      0x83EA: 'class', 0x83EB: 'id', 0x83FE: 'datafld', 0x83FF: 'datasrc',
      0x8400: 'dataformatas', 0x87D6: 'accesskey', 0x9392: 'lang', 0x93ED: 'language',
      0x93FE: 'dir',
    };
  }

  convert(data: Uint8Array): string {
    const out: string[] = [];
    const stack: { tagName: string; isGoingDown: boolean }[] = [];
    let pos = 0;
    let state: 'text' | 'flags' | 'tag' | 'attr' = 'text';
    let flags = 0;
    let tagName = '';
    let currentAttrs: Record<number, string> | null = null;
    let isGoingDown = false;
    let inCensorship = false;
    let count = 0;
    let isCloseTag = false;
    let attrBuf = '';

    const emit = (s: string) => out.push(s);

    const closeTag = () => {
      if (tagName) {
        if (tagName.startsWith('?')) {
          tagName = '';
          return;
        }
        emit(`</${tagName}>`);
        tagName = '';
      }
    };

    while (pos < data.length) {
      const c = data[pos++];

      if (state === 'text') {
        if (c === 0) {
          state = 'flags';
          continue;
        }
        const ch = c === 0x0b ? '\n' : c === 0x3e ? '>>' : c === 0x3c ? '<<' : String.fromCodePoint(c);
        emit(ch);
        continue;
      }

      if (state === 'flags') {
        if (c === 0) { state = 'text'; continue; }
        flags = c;
        state = 'tag';
        isCloseTag = !!(flags & 2);
        isGoingDown = !isCloseTag;
        continue;
      }

      if (state === 'tag') {
        state = 'attr';
        if (!(flags & 1)) {
          closeTag();
          break;
        }
        let tag = c;
        if (tag === 0x8000) {
          const [len, np] = readEncInt(data, pos);
          pos = np;
          if (data[pos]) pos = data[pos] + pos + 1;
          continue;
        }
        if (tag < this.tagMap.length) {
          const name = this.tagMap[tag];
          if (!name) throw new Error(`Unknown tag ${tag}`);
          tagName = name;
          currentAttrs = tag < this.tagAttrMap.length ? this.tagAttrMap[tag] : null;
        } else {
          tagName = `?${String.fromCodePoint(tag)}?`;
          currentAttrs = null;
        }
        if (tagName.startsWith('?')) { tagName = ''; continue; }
        emit('<');
        if (!isCloseTag) isGoingDown = true;
        emit(tagName);
        continue;
      }

      if (state === 'attr') {
        if (c === 0) {
          state = 'text';
          if (!isGoingDown) {
            emit(' />');
          } else {
            emit('>');
            stack.push({ tagName, isGoingDown: true });
          }
          tagName = '';
          continue;
        }
        if (c === 0x8000) {
          continue;
        }
        let attrName: string | null = null;
        if (currentAttrs && currentAttrs[c] !== undefined) {
          attrName = currentAttrs[c];
        } else if (this.attrMap[c] !== undefined) {
          attrName = this.attrMap[c];
        }
        if (!attrName) continue;
        if (attrName.startsWith('%')) {
          inCensorship = true;
          state = 'attr';
          const [vl, np] = readEncInt(data, pos);
          pos = np;
          if (vl > 0) pos += vl;
          inCensorship = false;
          continue;
        }
        inCensorship = false;
        emit(` ${attrName}=`);
        const isHref = attrName === 'href' || attrName === 'src';
        if (isHref) {
          state = 'attr';
          attrBuf = '';
          const [vl, np] = readEncInt(data, pos);
          pos = np;
          if (pos < data.length) {
            for (let i = 0; i < vl && pos < data.length; i++) {
              const ch = data[pos++];
              attrBuf += ch === 0x22 ? '&quot;' : ch === 0x3c ? '&lt;' : String.fromCodePoint(ch);
            }
          }
          if (attrBuf) {
            const doc = attrBuf.substring(1);
            emit(`"${doc}"`);
          } else {
            emit('""');
          }
        } else {
          emit('"');
          const [vl, np] = readEncInt(data, pos);
          pos = np;
          for (let i = 0; i < vl && pos < data.length; i++) {
            const ch = data[pos];
            if (ch === 0xFFFE) { pos++; break; }
            pos++;
            if (ch === 0x22) emit('&quot;');
            else if (ch === 0x3c) emit('&lt;');
            else emit(String.fromCodePoint(ch));
          }
          emit('"');
        }
        continue;
      }
    }

    while (stack.length) {
      const f = stack.pop();
      if (f) emit(`</${f.tagName}>`);
    }

    return out.join('');
  }
}

interface LitEntry {
  name: string;
  section: number;
  offset: number;
  size: number;
}

interface ManifestItem {
  internal: string;
  original: string;
  mimeType: string;
  offset: number;
  root: string;
  state: string;
  path: string;
}

export async function parseLitFile(file: File): Promise<LitBook> {
  const buffer = await file.arrayBuffer();
  const data = new Uint8Array(buffer);

  // Magic
  const magic = new TextDecoder('ascii').decode(data.slice(0, 8));
  if (magic !== 'ITOLITLS') throw new Error('Not a valid LIT file');
  const version = u32(data, 8);
  if (version !== 1) throw new Error(`Unknown LIT version ${version}`);

  const hdrLen = i32(data, 12);
  const numPieces = i32(data, 16);
  const secHdrLen = i32(data, 20);

  // Read secondary header for content offset
  let contentOffset = 0;
  const secHdrOff = hdrLen + numPieces * 16;
  const secHdr = data.slice(secHdrOff, secHdrOff + secHdrLen);
  for (let off = 0; off < secHdr.length - 4; off++) {
    if (secHdr[off] === 0x49 && secHdr[off + 1] === 0x54 && secHdr[off + 2] === 0x53 && secHdr[off + 3] === 0x46) {
      const offset64 = u32(secHdr, off + 16);
      const offset32 = u32(secHdr, off + 20);
      contentOffset = offset64 || offset32;
      break;
    }
  }
  if (!contentOffset) throw new Error('Could not find content offset');

  // Read header pieces for directory
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < numPieces; i++) {
    const poff = hdrLen + i * 16;
    const pieceOff = u32(data, poff);
    const pieceSize = i32(data, poff + 8);
    if (pieceOff === 0 && pieceSize === 0) continue;
    pieces.push(data.slice(pieceOff, pieceOff + pieceSize));
  }

  // Parse directory from piece 1
  const dirPiece = pieces[1];
  if (!dirPiece) throw new Error('Missing directory piece');
  const dirMagic = new TextDecoder('ascii').decode(dirPiece.slice(0, 4));
  if (dirMagic !== 'IFCM') throw new Error('Invalid directory piece');

  const entries: LitEntry[] = [];
  const iFcmVersion = u32(dirPiece, 4);
  const iFcmHeaderLen = iFcmVersion === 1 ? 32 : (u16(dirPiece, 6) || 24);
  const chunkSize = u32(dirPiece, iFcmVersion === 1 ? 8 : 16);
  const numChunks = iFcmVersion === 1 ? 1 : u32(dirPiece, 20);
  for (let ci = 0; ci < numChunks; ci++) {
    const chunkOff = iFcmHeaderLen + ci * chunkSize;
    if (chunkOff + 4 > dirPiece.length) break;
    if (ci === 0) {
      const tag = new TextDecoder('ascii').decode(dirPiece.slice(chunkOff, chunkOff + 4));
      if (tag !== 'AOLL') continue;
    } else break;
    const remaining = i32(dirPiece, chunkOff + 4);
    const entriesCount = u16(dirPiece, chunkOff + chunkSize - 2);
    if (entriesCount === 0) continue;
    let dp = chunkOff + 44;
    const chunkEnd = chunkSize - remaining + chunkOff;
    for (let ei = 0; ei < entriesCount; ei++) {
      if (dp >= chunkEnd) break;
      const [nameLen, np1] = readEncInt(dirPiece, dp);
      dp = np1;
      if (dp + nameLen > dirPiece.length) break;
      const name = new TextDecoder('utf-8').decode(dirPiece.slice(dp, dp + nameLen));
      dp += nameLen;
      const [section, np2] = readEncInt(dirPiece, dp);
      dp = np2;
      const [eOff, np3] = readEncInt(dirPiece, dp);
      dp = np3;
      const [eSize, np4] = readEncInt(dirPiece, dp);
      dp = np4;
      entries.push({ name, section, offset: eOff, size: eSize });
    }
  }

  // Read section names
  const nameListEntry = entries.find(e => e.name === '::DataSpace/NameList');
  if (!nameListEntry) throw new Error('No NameList in LIT file');
  let nameListRaw = (nameListEntry.section === 0)
    ? data.slice(contentOffset + nameListEntry.offset, contentOffset + nameListEntry.offset + nameListEntry.size)
    : data.slice(nameListEntry.offset, nameListEntry.offset + nameListEntry.size);
  let nlp = 0;
  while (nlp + 4 < nameListRaw.length) {
    const probe = u16(nameListRaw, nlp + 2);
    if (probe >= 2 && probe <= 10) break;
    nlp++;
  }
  nameListRaw = nameListRaw.slice(nlp);
  const numSections = u16(nameListRaw, 2);
  const sectionNames: string[] = [];
  let sp = 4;
  for (let i = 0; i < numSections; i++) {
    if (sp + 2 > nameListRaw.length) break;
    const sz = u16(nameListRaw, sp) * 2 + 2;
    sp += 2;
    if (sp + sz > nameListRaw.length) break;
    sectionNames.push(new TextDecoder('utf-16le').decode(nameListRaw.slice(sp, sp + sz)).replace(/\0/g, ''));
    sp += sz;
  }

  // Read section content with transform pipeline
  const getFile = (entry: LitEntry): Uint8Array => {
    if (entry.section === 0) return data.slice(contentOffset + entry.offset, contentOffset + entry.offset + entry.size);
    const secData = getSection(entry.section);
    return secData.slice(entry.offset, entry.offset + entry.size);
  };

  const sectionCache: (Uint8Array | null)[] = new Array(numSections).fill(null);
  const getSection = (secIdx: number): Uint8Array => {
    if (sectionCache[secIdx]) return sectionCache[secIdx]!;
    const name = sectionNames[secIdx] || '';
    const storagePath = `::DataSpace/Storage/${name}`;
    const transformEntry = entries.find(e => e.name === `${storagePath}/Transform/List`);
    const contentEntry = entries.find(e => e.name === `${storagePath}/Content`);
    const controlEntry = entries.find(e => e.name === `${storagePath}/ControlData`);
    if (!transformEntry || !contentEntry || !controlEntry) {
      const raw = entries.find(e => e.section === secIdx);
      return raw ? data.slice(raw.offset, raw.offset + raw.size) : new Uint8Array(0);
    }

    let content = getFile(contentEntry);
    const control = getFile(controlEntry);
    let transform = getFile(transformEntry);

    while (transform.length >= 16) {
      const guid = guidStr(transform, 0);
      if (guid === DESENCRYPT_GUID) {
        throw new Error('DRM-védett LIT fájl nem támogatott');
      } else if (guid === LZXCOMPRESS_GUID) {
        const resetEntry = entries.find(e => e.name.startsWith(`${storagePath}/Transform/${LZXCOMPRESS_GUID}/InstanceData/ResetTable`));
        if (!resetEntry) throw new Error('Missing LZX ResetTable');
        const resetTable = getFile(resetEntry);

        let wbits = 14;
        let u = u32(control, CONTROL_WINDOW_SIZE);
        while (u) { u >>= 1; wbits++; }
        if (wbits < 15 || wbits > 21) throw new Error(`Invalid LZX window ${wbits}`);

        const ucLength = i32(resetTable, 16);
        const interval = i32(resetTable, 32);
        const windowBytes = 1 << wbits;

        // Decompress frame by frame using reset table
        const decompressed: Uint8Array[] = [];
        let compBase = 0;
        let remaining = ucLength;
        let ofsEntry = i32(resetTable, 12) + 8;
        let accum = 0;

        while (ofsEntry < resetTable.length) {
          if (accum >= windowBytes) {
            accum = 0;
            const size = i32(resetTable, ofsEntry);
            const frameComp = content.slice(compBase, size);
            const frameDecomp = decompressBlock(frameComp, Math.min(windowBytes, remaining), wbits);
            decompressed.push(frameDecomp);
            remaining -= windowBytes;
            compBase = size;
          }
          accum += interval;
          ofsEntry += 8;
        }

        if (remaining > 0) {
          const last = decompressBlock(content.slice(compBase), remaining, wbits);
          decompressed.push(last);
        }

        const totalLen = decompressed.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let moff = 0;
        for (const d of decompressed) { merged.set(d, moff); moff += d.length; }
        content = merged;
      } else {
        throw new Error(`Unrecognized transform: ${guid}`);
      }
      transform = transform.slice(16);
    }

    sectionCache[secIdx] = content;
    return content;
  };

  // Read manifest
  const manifestEntry = entries.find(e => e.name === '/manifest');
  if (!manifestEntry) throw new Error('No manifest in LIT file');

  const getEntryByName = (name: string): LitEntry | undefined => entries.find(e => e.name === name);

  const parseManifest = () => {
    const raw = getFile(manifestEntry);
    const items: ManifestItem[] = [];
    let mp = 0;
    while (mp < raw.length) {
      const slen = raw[mp++];
      if (slen === 0) break;
      const root = new TextDecoder('utf-8').decode(raw.slice(mp, mp + slen));
      mp += slen;
      for (const state of ['spine', 'not spine', 'css', 'images']) {
        if (mp + 4 > raw.length) break;
        const numFiles = i32(raw, mp);
        mp += 4;
        if (numFiles === 0) continue;
        for (let fi = 0; fi < numFiles; fi++) {
          if (mp + 4 > raw.length) break;
          const offset = u32(raw, mp);
          mp += 4;
          let internal = '';
          while (mp < raw.length) {
            const [ch, np] = readUtf8Char(raw, mp);
            mp = np;
            if (ch === '\0') break;
            internal += ch;
          }
          let original = '';
          while (mp < raw.length) {
            const [ch, np] = readUtf8Char(raw, mp);
            mp = np;
            if (ch === '\0') break;
            original += ch;
          }
          let mimeType = '';
          while (mp < raw.length) {
            const [ch, np] = readUtf8Char(raw, mp);
            mp = np;
            if (ch === '\0') break;
            mimeType += ch;
          }
          const path = original.replace(/\\/g, '/').replace(/^[a-zA-Z]:\//, '').replace(/\.\.\//g, '');
          items.push({ internal, original, mimeType: mimeType.toLowerCase(), offset, root, state, path });
        }
      }
    }

    // Strip common path prefix
    if (items.length > 1) {
      let shared = items[0].path;
      for (const item of items.slice(1)) {
        while (shared && !item.path.startsWith(shared)) {
          const idx = shared.lastIndexOf('/', shared.length - 2);
          shared = idx >= 0 ? shared.substring(0, idx + 1) : '';
        }
        if (!shared) break;
      }
      if (shared) {
        for (const item of items) item.path = item.path.substring(shared.length);
      }
    }
    return items;
  };

  const manifest = parseManifest();

  // Check for DRM
  const drmKeys = ['/DRMStorage/Licenses/EUL', '/DRMStorage/DRMBookplate', '/DRMStorage/DRMSealed'];
  for (const dk of drmKeys) {
    if (getEntryByName(dk)) throw new Error('DRM-védett LIT fájl nem támogatott');
  }

  // Read metadata (OPF format)
  const metaData = getEntryByName('/meta');
  let title = file.name.replace(/\.lit$/i, '');
  let author = 'Ismeretlen szerző';
  if (metaData) {
    const metaRaw = getFile(metaData);
    const ub = new UnBinary(true);
    const opfXml = '<?xml version="1.0" encoding="UTF-8"?>' + ub.convert(metaRaw);
    const titleMatch = opfXml.match(/<dc:Title[^>]*>([^<]+)<\/dc:Title>/i);
    if (titleMatch) title = titleMatch[1];
    const creatorMatch = opfXml.match(/<dc:Creator[^>]*>([^<]+)<\/dc:Creator>/i);
    if (creatorMatch) author = creatorMatch[1];
  }

  // Build path to internal ID mapping
  const pathMap = new Map<string, ManifestItem>();
  for (const item of manifest) pathMap.set(item.path, item);
  pathMap.set('content.opf', manifest.find(i => i.internal === '') || null);

  // Read spine items (HTML content)
  const spineItems = manifest.filter(i => i.state === 'spine');
  const htmlParts: string[] = [];
  const toc: { id: string; label: string; level: number }[] = [];

  for (const item of spineItems) {
    const contentPath = `/data/${item.internal}/content`;
    const contentEntry = getEntryByName(contentPath);
    if (!contentEntry) continue;
    try {
      const raw = getFile(contentEntry);
      const ub = new UnBinary(false);
      const html = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n' + ub.convert(raw);
      htmlParts.push(html);

      // Extract heading for TOC
      const hMatch = html.match(/<h([1-6])[^>]*>([^<]+)<\/h\1>/i);
      if (hMatch) {
        toc.push({
          id: `lit-${toc.length}`,
          label: hMatch[2].replace(/<[^>]+>/g, '').trim(),
          level: parseInt(hMatch[1]),
        });
      }
    } catch { }
  }

  // Read CSS items
  const cssItems = manifest.filter(i => i.state === 'css');
  const cssParts: string[] = [];
  for (const item of cssItems) {
    const contentPath = `/data/${item.internal}`;
    const contentEntry = getEntryByName(contentPath);
    if (contentEntry) {
      const raw = getFile(contentEntry);
      cssParts.push(new TextDecoder('utf-8').decode(raw));
    }
  }

  const fullHtml = [
    '<html><head>',
    title ? `<title>${title.replace(/</g, '&lt;')}</title>` : '',
    cssParts.length ? `<style>${cssParts.join('\n')}</style>` : '',
    '</head><body>',
    ...htmlParts.map(h => {
      const bodyMatch = h.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      return bodyMatch ? bodyMatch[1] : h;
    }),
    '</body></html>',
  ].join('\n');

  return { title, author, htmlContent: fullHtml, toc };
}
