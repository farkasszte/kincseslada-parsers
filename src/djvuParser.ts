// kincseslada – DjVu ebook format parser
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
// Uses djvujs-dist (GPL-2.0): https://github.com/nickolay/djvujs

import DjVuDocument from 'djvujs-dist/library/src/DjVuDocument';

export interface DjvuPage {
  index: number;
  title: string;
  url?: string;
  text?: string;
  width?: number;
  height?: number;
}

export interface DjvuBook {
  title: string;
  totalPages: number;
  pages: DjvuPage[];
  toc: { id: string; label: string; pageIndex: number }[];
}

export interface DjvuParseOptions {
  startPage?: number;
  endPage?: number;
}

export async function parseDjvuFile(file: File, options?: DjvuParseOptions, onProgress?: (current: number, total: number) => void): Promise<DjvuBook> {
  const buffer = await file.arrayBuffer();
  const doc = new DjVuDocument(buffer);

  const totalPages = doc.getPagesQuantity();
  const startPage = options?.startPage ?? 1;
  const endPage = options?.endPage ?? totalPages;
  const pages: DjvuPage[] = [];
  const toc: { id: string; label: string; pageIndex: number }[] = [];

  try {
    const contents = doc.getContents();
    if (contents && contents.items) {
      for (let i = 0; i < contents.items.length; i++) {
        const item = contents.items[i];
        toc.push({
          id: `djvu-toc-${i}`,
          label: item.title || `${i + 1}. fejezet`,
          pageIndex: item.pageNumber ? item.pageNumber - 1 : 0
        });
      }
    }
  } catch (_) {}

  // Decode only requested page range
  const decodedCount = startPage - 1;
  for (let i = startPage; i <= endPage; i++) {
    if (onProgress && (i === startPage || i % 5 === 0 || i === endPage)) {
      onProgress(i - decodedCount, totalPages);
    }
    try {
      const page = await doc.getPage(i);
      const pageInfo = await page.createPngObjectUrl();

      let textContent = '';
      try {
        textContent = page.getText() || '';
      } catch (_) {}

      pages.push({
        index: i - 1,
        title: `${i}. oldal`,
        url: pageInfo.url,
        text: textContent,
        width: pageInfo.width,
        height: pageInfo.height
      });
    } catch (err) {
      pages.push({
        index: i - 1,
        title: `${i}. oldal (Hiba)`,
        text: `Hiba a(z) ${i}. oldal dekódolása során.`
      });
    }
  }

  if (toc.length === 0) {
    for (let i = 0; i < totalPages; i += Math.max(1, Math.floor(totalPages / 20))) {
      toc.push({
        id: `djvu-toc-auto-${i}`,
        label: `${i + 1}. oldal`,
        pageIndex: i
      });
    }
  }

  return {
    title: file.name.replace(/\.[^/.]+$/, ''),
    totalPages,
    pages,
    toc
  };
}
