const FRAME_SIZE = 0x8000;
const MIN_MATCH = 2;
const NUM_CHARS = 256;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const PRETREE_ELEMENTS = 20;
const ALIGNED_ELEMENTS = 8;
const MAX_HUFF_BITS = 16;

const BLOCKTYPE_VERBATIM = 1;
const BLOCKTYPE_ALIGNED = 2;
const BLOCKTYPE_UNCOMPRESSED = 3;

const EXTRA_BITS = new Uint8Array(51);
for (let i = 0, j = 0; i <= 50; i += 2) {
  EXTRA_BITS[i] = j;
  EXTRA_BITS[i + 1] = j;
  if (i !== 0 && j < 17) j++;
}
const POSITION_BASE = new Int32Array(51);
for (let i = 0, j = 0; i <= 50; i++) {
  POSITION_BASE[i] = j;
  j += 1 << EXTRA_BITS[i];
}

function log2(n) {
  let b = 0;
  while ((1 << b) < n && b < 31) b++;
  return b;
}

function positionSlots(windowBits) {
  if (windowBits === 20) return 42;
  if (windowBits === 21) return 50;
  return windowBits * 2;
}

class BitReader {
  constructor(bytes, start, end) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
    this.buf = 0;
    this.bitsLeft = 0;
  }

  ensure(n) {
    while (this.bitsLeft < n) {
      const b0 = this.pos < this.end ? this.bytes[this.pos] : 0;
      const b1 = this.pos + 1 < this.end ? this.bytes[this.pos + 1] : 0;
      const word = (b1 << 8) | b0;
      this.buf = (this.buf | (word << (16 - this.bitsLeft))) >>> 0;
      this.bitsLeft += 16;
      this.pos += 2;
    }
  }

  readBits(n) {
    if (n === 0) return 0;
    this.ensure(n);
    const v = this.buf >>> (32 - n);
    this.buf = (this.buf << n) >>> 0;
    this.bitsLeft -= n;
    return v;
  }

  readBit() {
    if (this.bitsLeft < 1) this.ensure(1);
    const v = this.buf >>> 31;
    this.buf = (this.buf << 1) >>> 0;
    this.bitsLeft -= 1;
    return v;
  }

  align16() {
    this.ensure(16);
    if (this.bitsLeft > 16) this.pos -= 2;
    this.buf = 0;
    this.bitsLeft = 0;
    return this.pos;
  }
}

function buildHuffman(lengths, nsyms) {
  const counts = new Int32Array(MAX_HUFF_BITS + 1);
  for (let s = 0; s < nsyms; s++) {
    const len = lengths[s];
    if (len) counts[len]++;
  }
  const offsets = new Int32Array(MAX_HUFF_BITS + 2);
  for (let len = 1; len <= MAX_HUFF_BITS; len++) offsets[len + 1] = offsets[len] + counts[len];
  const symbols = new Int32Array(offsets[MAX_HUFF_BITS + 1]);
  const next = offsets.slice();
  for (let s = 0; s < nsyms; s++) {
    const len = lengths[s];
    if (len) symbols[next[len]++] = s;
  }
  return { counts, symbols };
}

function decodeSymbol(reader, huff) {
  const { counts, symbols } = huff;
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_HUFF_BITS; len++) {
    code |= reader.readBit();
    const count = counts[len];
    if (code - first < count) return symbols[index + (code - first)];
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new Error('LZX: invalid Huffman code (corrupt stream)');
}

function readLengths(reader, lengths, first, last) {
  const preLen = new Uint8Array(PRETREE_ELEMENTS);
  for (let i = 0; i < PRETREE_ELEMENTS; i++) preLen[i] = reader.readBits(4);
  const pretree = buildHuffman(preLen, PRETREE_ELEMENTS);

  let i = first;
  while (i < last) {
    let z = decodeSymbol(reader, pretree);
    if (z === 17) {
      let run = reader.readBits(4) + 4;
      while (run-- > 0 && i < last) lengths[i++] = 0;
    } else if (z === 18) {
      let run = reader.readBits(5) + 20;
      while (run-- > 0 && i < last) lengths[i++] = 0;
    } else if (z === 19) {
      let run = reader.readBits(1) + 4;
      z = decodeSymbol(reader, pretree);
      let value = lengths[i] - z;
      if (value < 0) value += 17;
      while (run-- > 0 && i < last) lengths[i++] = value;
    } else {
      let value = lengths[i] - z;
      if (value < 0) value += 17;
      lengths[i++] = value;
    }
  }
}

class LzxState {
  constructor(windowBits) {
    this.windowBits = windowBits;
    this.mainElements = NUM_CHARS + (positionSlots(windowBits) << 3);
    this.mainLen = new Uint8Array(this.mainElements);
    this.lengthLen = new Uint8Array(NUM_SECONDARY_LENGTHS + 1);
    this.mainTree = null;
    this.lengthTree = null;
    this.alignedTree = null;
    this.intelFilesize = 0;
    this.reset();
  }

  reset() {
    this.R0 = 1;
    this.R1 = 1;
    this.R2 = 1;
    this.blockType = 0;
    this.blockRemaining = 0;
    this.headerRead = false;
    this.intelStarted = false;
    this.intelCurpos = 0;
    this.framesRead = 0;
    this.mainLen.fill(0);
    this.lengthLen.fill(0);
  }
}

function decodeFrame(state, reader, input, out, outStart, outEnd) {
  if (!state.headerRead) {
    if (reader.readBit()) {
      const hi = reader.readBits(16);
      const lo = reader.readBits(16);
      state.intelFilesize = hi * 0x10000 + lo;
    }
    state.headerRead = true;
  }

  let outPos = outStart;
  while (outPos < outEnd) {
    if (state.blockRemaining === 0) {
      state.blockType = reader.readBits(3);
      const hi = reader.readBits(16);
      const lo = reader.readBits(8);
      state.blockRemaining = hi * 256 + lo;

      if (state.blockType === BLOCKTYPE_ALIGNED) {
        const alignedLen = new Uint8Array(ALIGNED_ELEMENTS);
        for (let i = 0; i < ALIGNED_ELEMENTS; i++) alignedLen[i] = reader.readBits(3);
        state.alignedTree = buildHuffman(alignedLen, ALIGNED_ELEMENTS);
      }
      if (state.blockType === BLOCKTYPE_VERBATIM || state.blockType === BLOCKTYPE_ALIGNED) {
        readLengths(reader, state.mainLen, 0, NUM_CHARS);
        readLengths(reader, state.mainLen, NUM_CHARS, state.mainElements);
        state.mainTree = buildHuffman(state.mainLen, state.mainElements);
        if (state.mainLen[0xe8] !== 0) state.intelStarted = true;
        readLengths(reader, state.lengthLen, 0, NUM_SECONDARY_LENGTHS);
        state.lengthTree = buildHuffman(state.lengthLen, NUM_SECONDARY_LENGTHS + 1);
      } else if (state.blockType === BLOCKTYPE_UNCOMPRESSED) {
        state.intelStarted = true;
        const p = reader.align16();
        state.R0 = (input[p] | (input[p + 1] << 8) | (input[p + 2] << 16) | (input[p + 3] << 24)) >>> 0;
        state.R1 = (input[p + 4] | (input[p + 5] << 8) | (input[p + 6] << 16) | (input[p + 7] << 24)) >>> 0;
        state.R2 = (input[p + 8] | (input[p + 9] << 8) | (input[p + 10] << 16) | (input[p + 11] << 24)) >>> 0;
        reader.pos = p + 12;
      } else {
        throw new Error(`LZX: invalid block type ${state.blockType}`);
      }
    }

    let run = Math.min(state.blockRemaining, outEnd - outPos);

    if (state.blockType === BLOCKTYPE_UNCOMPRESSED) {
      for (let k = 0; k < run; k++) out[outPos++] = input[reader.pos++];
      state.blockRemaining -= run;
      reader.buf = 0;
      reader.bitsLeft = 0;
      if (state.blockRemaining === 0 && (reader.pos & 1)) reader.pos++;
      continue;
    }

    while (run > 0) {
      const mainElement = decodeSymbol(reader, state.mainTree);
      if (mainElement < NUM_CHARS) {
        out[outPos++] = mainElement;
        run--;
        state.blockRemaining--;
      } else {
        const sym = mainElement - NUM_CHARS;
        let matchLength = sym & NUM_PRIMARY_LENGTHS;
        if (matchLength === NUM_PRIMARY_LENGTHS) matchLength += decodeSymbol(reader, state.lengthTree);
        matchLength += MIN_MATCH;

        let matchOffset = sym >> 3;
        if (matchOffset > 2) {
          const extra = EXTRA_BITS[matchOffset];
          let off = POSITION_BASE[matchOffset] - 2;
          if (state.blockType === BLOCKTYPE_ALIGNED) {
            if (extra > 3) {
              off += reader.readBits(extra - 3) << 3;
              off += decodeSymbol(reader, state.alignedTree);
            } else if (extra === 3) {
              off += decodeSymbol(reader, state.alignedTree);
            } else if (extra > 0) {
              off += reader.readBits(extra);
            }
          } else if (extra > 0) {
            off += reader.readBits(extra);
          }
          matchOffset = off;
          state.R2 = state.R1;
          state.R1 = state.R0;
          state.R0 = matchOffset;
        } else if (matchOffset === 0) {
          matchOffset = state.R0;
        } else if (matchOffset === 1) {
          matchOffset = state.R1;
          state.R1 = state.R0;
          state.R0 = matchOffset;
        } else {
          matchOffset = state.R2;
          state.R2 = state.R0;
          state.R0 = matchOffset;
        }

        let src = outPos - matchOffset;
        if (src < 0) throw new Error('LZX: match references before start of stream');
        if (matchLength > run) matchLength = run;
        for (let k = 0; k < matchLength; k++) out[outPos++] = out[src++];
        run -= matchLength;
        state.blockRemaining -= matchLength;
      }
    }
  }

  if (state.intelFilesize !== 0) intelE8(out, outStart, outEnd - outStart, state);
}

function intelE8(out, outStart, frameLen, state) {
  if (state.framesRead++ >= 32768) return;
  if (frameLen <= 10 || !state.intelStarted) {
    state.intelCurpos += frameLen;
    return;
  }
  let curpos = state.intelCurpos;
  state.intelCurpos += frameLen;
  const filesize = state.intelFilesize;
  const end = outStart + frameLen - 10;
  let i = outStart;
  while (i < end) {
    if (out[i++] !== 0xe8) {
      curpos++;
      continue;
    }
    const absOff = (out[i] | (out[i + 1] << 8) | (out[i + 2] << 16) | (out[i + 3] << 24)) | 0;
    if (absOff >= -curpos && absOff < filesize) {
      const relOff = absOff >= 0 ? absOff - curpos : absOff + filesize;
      out[i] = relOff & 0xff;
      out[i + 1] = (relOff >> 8) & 0xff;
      out[i + 2] = (relOff >> 16) & 0xff;
      out[i + 3] = (relOff >> 24) & 0xff;
    }
    i += 4;
    curpos += 5;
  }
}

export function decompressStream(
  input,
  contentStart,
  compressedLength,
  addressTable,
  resetInterval,
  uncompressedLength,
  blockSize,
  windowSize,
) {
  const out = new Uint8Array(uncompressedLength);
  const state = new LzxState(log2(windowSize));
  const frames = addressTable.length;
  let written = 0;
  for (let frame = 0; frame < frames && written < uncompressedLength; frame++) {
    const inStart = contentStart + addressTable[frame];
    const inEnd = frame + 1 < frames ? contentStart + addressTable[frame + 1] : contentStart + compressedLength;
    const reader = new BitReader(input, inStart, inEnd);
    const frameLen = Math.min(blockSize, uncompressedLength - written);
    if (frame % resetInterval === 0) state.reset();
    decodeFrame(state, reader, input, out, written, written + frameLen);
    written += frameLen;
  }
  return out;
}

export function decompressBlock(compressed, outLen, windowBits) {
  const out = new Uint8Array(outLen);
  const state = new LzxState(log2(windowBits));
  state.reset();
  const reader = new BitReader(compressed, 0, compressed.length);
  decodeFrame(state, reader, compressed, out, 0, outLen);
  return out;
}

export { FRAME_SIZE, LzxState, BitReader, decodeFrame, log2 };

