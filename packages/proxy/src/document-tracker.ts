import * as v from 'valibot';
import type { TrackedDocument } from './types.ts';
import { normalizeFileUri } from './uri.ts';

export type DocumentMap = ReadonlyMap<string, TrackedDocument>;

// --- LSP param schemas ---

const PositionSchema = v.object({
  line: v.number(),
  character: v.number(),
});

const RangeSchema = v.object({
  start: PositionSchema,
  end: PositionSchema,
});

export const DidOpenParamsSchema = v.object({
  textDocument: v.object({
    uri: v.string(),
    languageId: v.string(),
    version: v.number(),
    text: v.string(),
  }),
});

const ContentChangeSchema = v.object({
  text: v.string(),
  range: v.optional(RangeSchema),
});

export const DidChangeParamsSchema = v.object({
  textDocument: v.object({
    uri: v.string(),
    version: v.number(),
  }),
  contentChanges: v.array(ContentChangeSchema),
});

export const DidCloseParamsSchema = v.object({
  textDocument: v.object({
    uri: v.string(),
  }),
});

// --- Derived types ---

type Position = v.InferOutput<typeof PositionSchema>;
type Range = v.InferOutput<typeof RangeSchema>;
export type DidOpenParams = v.InferOutput<typeof DidOpenParamsSchema>;
export type DidChangeParams = v.InferOutput<typeof DidChangeParamsSchema>;
export type DidCloseParams = v.InferOutput<typeof DidCloseParamsSchema>;

// --- Public API (pure functions, immutable state) ---

export const empty = (): DocumentMap => new Map();

export const trackOpen = (docs: DocumentMap, rawParams: unknown): DocumentMap => {
  const result = v.safeParse(DidOpenParamsSchema, rawParams);
  if (!result.success) return docs;
  const { languageId, version, text } = result.output.textDocument;
  const uri = normalizeFileUri(result.output.textDocument.uri);
  const next = new Map(docs);
  next.set(uri, { uri, languageId, version, content: text });
  return next;
};

export const trackChange = (docs: DocumentMap, rawParams: unknown): DocumentMap => {
  const result = v.safeParse(DidChangeParamsSchema, rawParams);
  if (!result.success) return docs;
  const params = result.output;
  const doc = docs.get(normalizeFileUri(params.textDocument.uri));
  if (!doc) return docs;

  const content = params.contentChanges.reduce(
    (text, change) =>
      change.range ? applyIncremental(text, change.range, change.text) : change.text,
    doc.content,
  );

  const next = new Map(docs);
  next.set(doc.uri, { ...doc, version: params.textDocument.version, content });
  return next;
};

export const trackClose = (docs: DocumentMap, rawParams: unknown): DocumentMap => {
  const result = v.safeParse(DidCloseParamsSchema, rawParams);
  if (!result.success) return docs;
  const next = new Map(docs);
  next.delete(normalizeFileUri(result.output.textDocument.uri));
  return next;
};

export const apply = (docs: DocumentMap, method: string, params: unknown): DocumentMap => {
  switch (method) {
    case 'textDocument/didOpen': return trackOpen(docs, params);
    case 'textDocument/didChange': return trackChange(docs, params);
    case 'textDocument/didClose': return trackClose(docs, params);
    default: return docs;
  }
};

export const toArray = (docs: DocumentMap): readonly TrackedDocument[] => [...docs.values()];

// --- Pure helpers ---

const positionToOffset = (text: string, pos: Position): number => {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const cr = text.indexOf('\r', offset);
    const lf = text.indexOf('\n', offset);
    const eol
      = cr === -1 && lf === -1
        ? -1
        : cr === -1
          ? lf
          : lf === -1
            ? cr
            : Math.min(cr, lf);
    if (eol === -1) return text.length;
    // Skip \r\n as a single line terminator
    offset = text[eol] === '\r' && text[eol + 1] === '\n' ? eol + 2 : eol + 1;
  }
  return Math.min(offset + pos.character, text.length);
};

const applyIncremental = (text: string, range: Range, replacement: string): string => {
  const start = positionToOffset(text, range.start);
  const end = positionToOffset(text, range.end);
  return text.slice(0, start) + replacement + text.slice(end);
};
