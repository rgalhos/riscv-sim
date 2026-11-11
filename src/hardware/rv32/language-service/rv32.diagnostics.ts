import { analyzeSource, type ISemanticErrorCause } from "../analyzer/rv32-analyzer.assembler";
import { ETokenType, type IToken } from "../analyzer/rv32-lexer.assembler";
import type { IParseErrorCause } from "../analyzer/rv32-parser.assembler";

export enum EDiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface IPosition {
  line: number;
  character: number;
}

export interface IRange {
  start: IPosition;
  end: IPosition;
}

export interface IDiagnostic {
  range: IRange;
  severity: EDiagnosticSeverity;
  message: string;
  source: string;
  code: string;
}

export const DIAGNOSTIC_SOURCE = "rv-sim";

const MACRO_ERROR_MESSAGES: Record<string, string> = {
  ASSEMBLER_MACRO_REDEFINED: "Macro redefined",
  ASSEMBLER_MACRO_UNCLOSED: "Unclosed .macro block",
  ASSEMBLER_MACRO_BAD_ARITY: "Macro invoked with wrong number of arguments",
  ASSEMBLER_MACRO_RECURSION: "Macro expansion exceeded maximum recursion depth",
  ASSEMBLER_MACRO_BAD_DEFINITION: "Invalid macro definition",
};

const TOKEN_DESCRIPTIONS: Record<ETokenType, string> = {
  [ETokenType.INVALID]: "token",
  [ETokenType.IDENTIFIER]: "identifier",
  [ETokenType.DIRECTIVE]: "directive",
  [ETokenType.IMMEDIATE]: "immediate",
  [ETokenType.STRING]: "string",
  [ETokenType.RELOC]: "relocation",
  [ETokenType.LABEL_DECL]: "label declaration",
  [ETokenType.LABEL_REF]: "label",
  [ETokenType.OPERATOR]: "operator",
  [ETokenType.LPAREN]: '"("',
  [ETokenType.RPAREN]: '")"',
  [ETokenType.COMMA]: '","',
};

const WORD_CHAR = "[A-Za-z0-9_.]";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineIndex(lines: string[], lineNumber: number) {
  return Math.min(Math.max(lineNumber - 1, 0), Math.max(lines.length - 1, 0));
}

function range(line: number, start: number, end: number): IRange {
  return { start: { line, character: start }, end: { line, character: end } };
}

function wholeLineRange(lines: string[], lineNumber: number): IRange {
  const idx = lineIndex(lines, lineNumber);
  const text = lines[idx] ?? "";
  const start = Math.max(text.search(/\S/), 0);
  const end = text.trimEnd().length;

  return range(idx, start, Math.max(end, start));
}

function wordRange(lines: string[], lineNumber: number, word: string): IRange | null {
  if (!word) return null;

  const idx = lineIndex(lines, lineNumber);
  const text = lines[idx] ?? "";
  const match = new RegExp(`(?<!${WORD_CHAR})${escapeRegex(word)}(?!${WORD_CHAR})`).exec(text);

  return match ? range(idx, match.index, match.index + word.length) : null;
}

function tokenText(token: IToken): string {
  if (token.lexeme) return token.lexeme;
  return typeof token.value === "string" ? token.value : "";
}

function tokenRange(lines: string[], token: IToken): IRange | null {
  const lexeme = tokenText(token);
  if (!lexeme) return null;

  const idx = lineIndex(lines, token.origin);
  const text = lines[idx] ?? "";

  if (text.startsWith(lexeme, token.column)) {
    return range(idx, token.column, token.column + lexeme.length);
  }

  const at = text.indexOf(lexeme);
  return at === -1 ? null : range(idx, at, at + lexeme.length);
}

function diagnostic(
  rangeValue: IRange,
  message: string,
  code: string,
  severity: EDiagnosticSeverity = EDiagnosticSeverity.Error
): IDiagnostic {
  return {
    range: rangeValue,
    severity,
    message,
    source: DIAGNOSTIC_SOURCE,
    code,
  };
}

function parseErrorMessage(cause: IParseErrorCause) {
  const got = cause.got;
  const text = got ? tokenText(got) : "";
  const found = text ? `"${text}"` : "";

  if (got?.type === ETokenType.INVALID) {
    return `Invalid token ${found}`;
  }

  if (cause.expected !== undefined) {
    const expected = `Expected ${TOKEN_DESCRIPTIONS[cause.expected] ?? ETokenType[cause.expected]}`;

    if (found) {
      return `${expected}, found ${found}`;
    }

    return got ? expected : `${expected}, found EOF`;
  }

  if (found) return `Unexpected ${found}`;
  return got ? "Syntax error" : "Unexpected EOF";
}

function parseErrorDiagnostic(e: Error, lines: string[]): IDiagnostic {
  const cause = e.cause as IParseErrorCause;
  const got = cause?.got;
  const origin = got?.origin ?? cause?.tokens?.[0]?.origin ?? cause?.line ?? 1;
  const rangeValue = (got && tokenRange(lines, got)) ?? wholeLineRange(lines, origin);

  return diagnostic(rangeValue, parseErrorMessage(cause ?? { tokens: [], line: origin }), e.message);
}

function semanticErrorDiagnostic(e: Error, lines: string[]): IDiagnostic {
  const cause = e.cause as ISemanticErrorCause;
  const line = cause?.line ?? 1;
  const symbol = cause?.symbol;
  const rangeValue = (symbol && wordRange(lines, line, symbol)) || wholeLineRange(lines, line);
  const message = symbol ? `${cause.message} (${symbol})` : (cause?.message ?? e.message);

  return diagnostic(rangeValue, message, e.message);
}

function semanticWarningDiagnostic(e: Error, lines: string[]): IDiagnostic {
  const cause = e.cause as ISemanticErrorCause;
  const line = cause?.line ?? 1;
  const symbol = cause?.symbol;
  const rangeValue = (symbol && wordRange(lines, line, symbol)) || wholeLineRange(lines, line);

  return diagnostic(rangeValue, cause?.message ?? e.message, e.message, EDiagnosticSeverity.Warning);
}

function causeLine(cause: unknown): number {
  if (Array.isArray(cause)) {
    for (const item of cause) {
      if (item && typeof item === "object") {
        if ("lineNumber" in item && typeof item.lineNumber === "number") return item.lineNumber;
        if ("origin" in item && typeof item.origin === "number" && item.origin !== 0) return item.origin;
      }
    }
  } else if (cause && typeof cause === "object" && "line" in cause && typeof cause.line === "number") {
    return cause.line;
  }

  return 1;
}

function toDiagnostic(e: Error, lines: string[]): IDiagnostic {
  if (e.message === "ASSEMBLER_PARSE_ERROR") return parseErrorDiagnostic(e, lines);
  if (e.message === "ASSEMBLER_SEMANTIC_ERROR") return semanticErrorDiagnostic(e, lines);
  if (e.message === "ASSEMBLER_SEMANTIC_WARNING") return semanticWarningDiagnostic(e, lines);

  const message = MACRO_ERROR_MESSAGES[e.message] ?? e.message;
  return diagnostic(wholeLineRange(lines, causeLine(e.cause)), message, e.message);
}

export function errorsToDiagnostics(errors: Error[], source: string): IDiagnostic[] {
  const lines = source.split("\n");
  const seen = new Set<string>();

  return errors
    .map((e) => toDiagnostic(e, lines))
    .filter((d) => {
      const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.character}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

export function getDiagnostics(source: string): IDiagnostic[] {
  let errors: Error[];

  try {
    const result = analyzeSource(source);
    errors = [...result.errors, ...result.warnings];
  } catch (e) {
    errors = [e instanceof Error ? e : new Error(String(e))];
  }

  return errorsToDiagnostics(errors, source);
}
