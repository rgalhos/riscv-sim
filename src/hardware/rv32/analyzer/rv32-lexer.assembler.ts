import type { ISourceLine } from "./rv32-pre.assembler";

export enum ETokenType {
  INVALID,
  IDENTIFIER,
  DIRECTIVE,
  IMMEDIATE,
  STRING,
  RELOC,
  LABEL_DECL,
  LABEL_REF,
  OPERATOR,
  LPAREN,
  RPAREN,
  COMMA,
}

export type TBinOp = "+" | "-" | "/" | "*";

export type IToken = {
  line: number;
  origin: number;
  column: number;
  lexeme: string;
} & (
  | {
      type:
        | ETokenType.IDENTIFIER
        | ETokenType.DIRECTIVE
        | ETokenType.LABEL_DECL
        | ETokenType.LABEL_REF
        | ETokenType.STRING
        | ETokenType.RELOC
        | ETokenType.INVALID;
      value: string;
    }
  | {
      type: ETokenType.IMMEDIATE;
      value: number;
    }
  | {
      type: ETokenType.OPERATOR | ETokenType.LPAREN | ETokenType.RPAREN | ETokenType.COMMA;
      value: TBinOp | "(" | ")" | ",";
    }
);

type ILexerState = {
  source: ISourceLine;
  idx: number;
};

const R_DIRECTIVE_MIDDLE = /[a-z0-9_]/i;
const R_IDENTIFIER_MIDDLE = /[a-z0-9_.]/i;
const R_RELOC_MIDDLE = /[a-z_]/;

const KNOWN_DIRECTIVES = new Set([
  ".text",
  ".data",
  ".bss",
  ".rodata",
  ".equ",
  ".byte",
  ".half",
  ".word",
  ".space",
  ".org",
  ".align",
  ".p2align",
  ".option",
  ".string",
  ".ascii",
  ".asciz",
  ".macro",
  ".endm",
  ".globl",
  ".global",
  ".zero",
]);

export const stringifyTokenizerError = (e: Error) => {
  if (!e.message.startsWith("ASSEMBLER_")) return e.toString();

  const lineNumber = ((e.cause as IToken[]) || []).find((v) => v.origin !== 0)?.origin || 0;
  const fullLine = ((e.cause as IToken[]) || []).map((v) => v.value).join(" ");
  let msg = "";

  if (e.message === "ASSEMBLER_UNEXPECTED_TOKEN") {
    const invalid = ((e.cause as IToken[]) || []).find((v) => v.type === ETokenType.INVALID);
    if (invalid) {
      msg = `Found invalid token (${invalid.value}) at line ${lineNumber}: ${fullLine}`;
    } else {
      msg = `Unexpected token at line ${lineNumber}: ${fullLine}`;
    }
  } else if (e.message === "ASSEMBLER_UNDECLARED_LABEL") {
    msg = `Undeclared constant or label referenced at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_UNKNOWN_KEYWORD") {
    msg = `Invalid keyword at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_CIRCULAR_DECLARATION") {
    msg = `Circular declaration detected at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_CONFLICTING_DECLARATION") {
    msg = `Label or constant declared twice at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_MACRO_REDEFINED") {
    msg = `Macro redefined at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_MACRO_UNCLOSED") {
    msg = `Unclosed .macro block starting at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_MACRO_BAD_ARITY") {
    msg = `Macro invoked with wrong number of arguments at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_MACRO_RECURSION") {
    msg = `Macro expansion exceeded maximum recursion depth at line ${lineNumber}: ${fullLine}`;
  } else if (e.message === "ASSEMBLER_MACRO_BAD_DEFINITION") {
    msg = `Invalid macro definition at line ${lineNumber}: ${fullLine}`;
  }

  return msg;
};

const dv = new DataView(new ArrayBuffer(8));

function pushToken(tokens: IToken[], state: ILexerState, column: number, type: ETokenType, value: unknown) {
  tokens.push({
    line: state.source.number,
    origin: state.source.origin,
    column,
    lexeme: state.source.line.slice(column, state.idx),
    type,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: value as any,
  });
}

function handleDirectiveOrLocalLabel(tokens: IToken[], state: ILexerState) {
  const col = state.idx;
  const line = state.source.line;
  let acc = line[state.idx++];

  while (state.idx < line.length && R_DIRECTIVE_MIDDLE.test(line[state.idx])) {
    acc += line[state.idx++];
  }

  if (line[state.idx] === ":") {
    state.idx++;
    pushToken(tokens, state, col, ETokenType.LABEL_DECL, acc);
  } else if (KNOWN_DIRECTIVES.has(acc.toLowerCase())) {
    pushToken(tokens, state, col, ETokenType.DIRECTIVE, acc);
  } else {
    pushToken(tokens, state, col, ETokenType.LABEL_REF, acc);
  }
}

function handleIdentifierOrLabel(tokens: IToken[], state: ILexerState) {
  const col = state.idx;
  const line = state.source.line;
  let acc = line[state.idx++];

  while (state.idx < line.length && R_IDENTIFIER_MIDDLE.test(line[state.idx])) {
    acc += line[state.idx++];
  }

  if (line[state.idx] === ":") {
    state.idx++;
    pushToken(tokens, state, col, ETokenType.LABEL_DECL, acc);
  } else {
    pushToken(tokens, state, col, ETokenType.IDENTIFIER, acc);
  }
}

function handleReloc(tokens: IToken[], state: ILexerState) {
  const col = state.idx++;
  const line = state.source.line;
  let acc = "";

  while (state.idx < line.length && R_RELOC_MIDDLE.test(line[state.idx])) {
    acc += line[state.idx++];
  }

  if (!acc) {
    pushToken(tokens, state, col, ETokenType.INVALID, "%");
    return;
  }

  pushToken(tokens, state, col, ETokenType.RELOC, acc.toLowerCase());
}

function handleImmediate(tokens: IToken[], state: ILexerState) {
  const col = state.idx;
  const line = state.source.line;
  let i = state.idx;
  let negative = 1;

  if (line[i] === "-") {
    negative = -1;
    i++;
  } else if (line[i] === "+") {
    i++;
  }

  if (i >= line.length) {
    if (negative === -1) {
      pushToken(tokens, state, col, ETokenType.OPERATOR, "-");
      return;
    }
    pushToken(tokens, state, col, ETokenType.INVALID, line[col]);
    state.idx = col + 1;
    return;
  }

  let valueStr = "";
  let isFloat = false;
  const c = line[i];

  if (c === "0" && /[xX]/.test(line[i + 1] ?? "")) {
    valueStr = line[i++] + line[i++];
    while (i < line.length && /[0-9a-fA-F]/.test(line[i])) valueStr += line[i++];
  } else if (c === "0" && /[bB]/.test(line[i + 1] ?? "")) {
    valueStr = line[i++] + line[i++];
    while (i < line.length && /[01]/.test(line[i])) valueStr += line[i++];
  } else if (/\d/.test(c)) {
    while (i < line.length && /\d/.test(line[i])) valueStr += line[i++];
  } else {
    if (negative === -1 && col === state.idx) {
      pushToken(tokens, state, col, ETokenType.OPERATOR, "-");
      state.idx = col + 1;
      return;
    }
    pushToken(tokens, state, col, ETokenType.INVALID, line[col]);
    state.idx = col + 1;
    return;
  }

  if (line[i] === ".") {
    isFloat = true;
    valueStr += line[i++];
    while (i < line.length && /\d/.test(line[i])) valueStr += line[i++];
  }

  state.idx = i;
  const v = Number(valueStr) * negative;

  if (isNaN(v)) {
    pushToken(tokens, state, col, ETokenType.INVALID, valueStr);
    return;
  }

  if (isFloat) {
    dv.setFloat32(0, v);
    pushToken(tokens, state, col, ETokenType.IMMEDIATE, dv.getUint32(0));
  } else {
    pushToken(tokens, state, col, ETokenType.IMMEDIATE, v);
  }
}

function handleLocalLabelOrNumber(tokens: IToken[], state: ILexerState) {
  const col = state.idx;
  const line = state.source.line;

  while (state.idx < line.length && /\d/.test(line[state.idx])) {
    state.idx++;
  }

  if (line[state.idx] === ":") {
    state.idx++;
    pushToken(tokens, state, col, ETokenType.LABEL_DECL, line.slice(col, state.idx - 1));
    return;
  }

  state.idx = col;
  handleImmediate(tokens, state);
}

function handleString(tokens: IToken[], state: ILexerState) {
  const col = state.idx++;
  const line = state.source.line;
  let value = "";

  while (state.idx < line.length && line[state.idx] !== '"') {
    let c = line[state.idx++];
    if (c === "\\") {
      c = line[state.idx++];
      if (c === "n") c = "\n";
      else if (c === "0") c = "\0";
    }
    value += c;
  }

  if (state.idx >= line.length) {
    pushToken(tokens, state, col, ETokenType.INVALID, value);
    return;
  }

  state.idx++;
  pushToken(tokens, state, col, ETokenType.STRING, value);
}

function handleChar(tokens: IToken[], state: ILexerState) {
  const col = state.idx;
  const line = state.source.line;
  const value = line[state.idx + 1];

  if (!value || line[state.idx + 2] !== "'") {
    pushToken(tokens, state, col, ETokenType.INVALID, "'");
    state.idx++;
    return;
  }

  state.idx += 3;
  pushToken(tokens, state, col, ETokenType.IMMEDIATE, value.charCodeAt(0));
}

function tokenizeLine(tokens: IToken[], sourceLine: ISourceLine) {
  const state: ILexerState = { source: sourceLine, idx: 0 };
  const line = sourceLine.line;

  while (state.idx < line.length) {
    const c = line[state.idx];

    if (/\s/.test(c)) {
      state.idx++;
      continue;
    }

    if (c === "#") break;

    if (c === ",") {
      pushToken(tokens, state, state.idx, ETokenType.COMMA, ",");
      state.idx++;
      continue;
    }

    if (c === ".") {
      handleDirectiveOrLocalLabel(tokens, state);
      continue;
    }

    if (c === "%") {
      handleReloc(tokens, state);
      continue;
    }

    if (c === "(") {
      pushToken(tokens, state, state.idx, ETokenType.LPAREN, "(");
      state.idx++;
      continue;
    }

    if (c === ")") {
      pushToken(tokens, state, state.idx, ETokenType.RPAREN, ")");
      state.idx++;
      continue;
    }

    if (c === '"') {
      handleString(tokens, state);
      continue;
    }

    if (c === "'") {
      handleChar(tokens, state);
      continue;
    }

    if (c === "*" || c === "/") {
      pushToken(tokens, state, state.idx, ETokenType.OPERATOR, c);
      state.idx++;
      continue;
    }

    if (c === "+" || c === "-") {
      const prev = tokens[tokens.length - 1];
      const prevIsValue =
        prev &&
        (prev.type === ETokenType.IMMEDIATE ||
          prev.type === ETokenType.IDENTIFIER ||
          prev.type === ETokenType.LABEL_REF ||
          prev.type === ETokenType.RPAREN);
      const next = line[state.idx + 1];
      if (!prevIsValue && (/\d/.test(next) || (next === "0" && /[xXbB]/.test(line[state.idx + 2] ?? "")))) {
        handleImmediate(tokens, state);
      } else {
        pushToken(tokens, state, state.idx, ETokenType.OPERATOR, c);
        state.idx++;
      }
      continue;
    }

    if (/\d/.test(c)) {
      handleLocalLabelOrNumber(tokens, state);
      continue;
    }

    if (/[a-z_.]/i.test(c)) {
      handleIdentifierOrLabel(tokens, state);
      continue;
    }

    pushToken(tokens, state, state.idx, ETokenType.INVALID, c);
    state.idx++;
  }
}

export function tokenizer(source: ISourceLine[]) {
  const tokens: IToken[] = [];

  for (const sourceLine of source) {
    tokenizeLine(tokens, sourceLine);
  }

  return tokens;
}
