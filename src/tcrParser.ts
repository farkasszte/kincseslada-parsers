// kincseslada – TCR ebook format parser
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
// Based on Calibre's TCR parser (GPL v3):
//   https://github.com/kovidgoyal/calibre/blob/master/src/calibre/ebooks/tcr/
// Modified by Farkas Gergely for browser-based TypeScript.

export function decompressTcr(data: Uint8Array): string {
  const decoder = new TextDecoder('windows-1252');
  const header = decoder.decode(data.slice(0, 9));
  if (header !== '!!8-Bit!!') throw new Error('Invalid TCR header: missing !!8-Bit!! magic');

  let pos = 9;
  const entries: string[] = [];
  for (let i = 0; i < 256; i++) {
    const len = data[pos++];
    if (len === 0) {
      entries.push('');
    } else {
      entries.push(decoder.decode(data.slice(pos, pos + len)));
      pos += len;
    }
  }

  const parts: string[] = [];
  while (pos < data.length) {
    const code = data[pos++];
    parts.push(entries[code]);
  }
  return parts.join('');
}

export async function parseTcrFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return decompressTcr(new Uint8Array(buffer));
}
