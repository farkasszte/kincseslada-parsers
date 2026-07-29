const BOM_UTF8 = [0xEF, 0xBB, 0xBF];
const BOM_UTF16LE = [0xFF, 0xFE];
const BOM_UTF16BE = [0xFE, 0xFF];

const CHARSET_ALIASES: Record<string, string> = {
  'macintosh': 'mac-roman',
  'x-sjis': 'shift-jis',
  'mac-centraleurope': 'cp1250',
  'gb2312': 'gbk',
  'chinese': 'gbk',
  'csiso58gb231280': 'gbk',
  'euc-cn': 'gbk',
  'euccn': 'gbk',
  'eucgb2312-cn': 'gbk',
  'gb2312-1980': 'gbk',
  'gb2312-80': 'gbk',
  'iso-ir-58': 'gbk',
};

const ENCODING_PATTERNS = [
  /<\?[^<>]+encoding\s*=\s*['"]([-_a-z0-9]+)['"][^<>]*>/i,
  /<meta\s+charset=['"]([-_a-z0-9]+)['"][^<>]*>(?:\s*<\/meta>)?/i,
  /<meta\s+[^<>]*?content\s*=\s*['"][^'"]*?charset=([-_a-z0-9]+)[^'"]*?['"][^<>]*>(?:\s*<\/meta>)?/i,
];

export function findDeclaredEncoding(raw: string | Uint8Array, limit = 50 * 1024): string | null {
  const prefix = typeof raw === 'string'
    ? raw.slice(0, limit)
    : new TextDecoder('utf-8', { fatal: false }).decode(raw.slice(0, limit));
  for (const pat of ENCODING_PATTERNS) {
    const m = pat.exec(prefix);
    if (m) {
      let enc = m[1].toLowerCase();
      enc = CHARSET_ALIASES[enc] || enc;
      return enc;
    }
  }
  return null;
}

export function detectBOM(raw: Uint8Array): { encoding: string; strip: number } | null {
  if (raw.length >= 3 && raw[0] === BOM_UTF8[0] && raw[1] === BOM_UTF8[1] && raw[2] === BOM_UTF8[2])
    return { encoding: 'utf-8', strip: 3 };
  if (raw.length >= 2 && raw[0] === BOM_UTF16LE[0] && raw[1] === BOM_UTF16LE[1])
    return { encoding: 'utf-16le', strip: 2 };
  if (raw.length >= 2 && raw[0] === BOM_UTF16BE[0] && raw[1] === BOM_UTF16BE[1])
    return { encoding: 'utf-16be', strip: 2 };
  return null;
}

const COMMON_ENCODINGS = [
  'utf-8', 'windows-1252', 'iso-8859-1', 'iso-8859-2',
  'shift-jis', 'gbk', 'euc-kr', 'big5', 'windows-1251',
  'windows-1250', 'iso-8859-15', 'mac-roman',
];

function tryDecode(raw: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

export interface EncodingResult {
  encoding: string;
  text: string;
  confidence: number;
}

export function detectEncoding(raw: Uint8Array): EncodingResult {
  const bom = detectBOM(raw);
  if (bom) {
    const stripped = raw.slice(bom.strip);
    const text = tryDecode(stripped, bom.encoding);
    if (text !== null) return { encoding: bom.encoding, text, confidence: 1 };
  }

  const preamble = raw.slice(0, 50 * 1024);
  const declared = findDeclaredEncoding(preamble);
  if (declared) {
    const resolved = CHARSET_ALIASES[declared] || declared;
    const text = tryDecode(raw, resolved);
    if (text !== null) return { encoding: resolved, text, confidence: 0.9 };
  }

  for (const enc of COMMON_ENCODINGS) {
    const text = tryDecode(raw, enc);
    if (text !== null) {
      return { encoding: enc, text, confidence: 0.7 };
    }
  }

  return {
    encoding: 'utf-8',
    text: new TextDecoder('utf-8', { fatal: false }).decode(raw),
    confidence: 0.3,
  };
}

export function stripEncodingDeclarations(text: string, limit = 50 * 1024): string {
  let prefix = text.slice(0, limit);
  const suffix = text.slice(limit);
  for (const pat of ENCODING_PATTERNS) {
    prefix = prefix.replace(pat, '');
  }
  return prefix + suffix;
}

export function normalizeEncoding(enc: string): string {
  let e = enc.toLowerCase().replace(/[_-]/g, '-').trim();
  e = CHARSET_ALIASES[e] || e;
  if (e === 'ascii') e = 'utf-8';
  try {
    new TextDecoder(e);
    return e;
  } catch {
    return 'utf-8';
  }
}
