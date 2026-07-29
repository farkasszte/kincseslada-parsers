export { parseLitFile } from './litParser';
export type { LitBook } from './litParser';

export { parsePdbFile } from './pdbParser';
export type { PdbBook } from './pdbParser';

export { parseTcrFile } from './tcrParser';

export { parseDjvuFile } from './djvuParser';
export type { DjvuPage, DjvuBook, DjvuParseOptions } from './djvuParser';

export { detectEncoding, detectBOM, findDeclaredEncoding, stripEncodingDeclarations, normalizeEncoding } from './chardet';
export type { EncodingResult } from './chardet';

export { processComicPages } from './comicUtils';
export type { SplitResult } from './comicUtils';

export { resolveImage, decodeChmText, cleanupChmHtml } from './chmUtils';

export { DocxStyleResolver } from './docxGpl';
export type { DocxStyle, DocxRunProps } from './docxGpl';

export { parseHtmlFile } from './htmlGpl';
export type { HtmlBook } from './htmlGpl';
