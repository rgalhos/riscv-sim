import { rv_reg, rv_reg_f } from "../rv32.const";
import { ETokenType, tokenizer, type IToken } from "./rv32-lexer.assembler";
import { preprocessor } from "./rv32-pre.assembler";

const REGISTER_NAMES = new Set(
  [...Object.keys(rv_reg), ...Object.keys(rv_reg_f)].filter((name) => Number.isNaN(Number(name)))
);

export enum EKind {
  INSTRUCTION,
  DIRECTIVE,
  REG,
  MEM,
  EXPR,
  NUM,
  SYM,
  UNARY,
  BINARY,
  RELOC,
  STRING,
}

export type IProgram = { lines: ILine[] };

export type IParseResult = {
  program: IProgram;
  errors: Error[];
};

export type ILine = {
  line: number;
  origin: number;
  label?: string;
  stmt?: IStatement;
  hasErrors: boolean;
};

export type IStatement =
  | { kind: EKind.INSTRUCTION; mnemonic: string; operands: IOperand[] }
  | { kind: EKind.DIRECTIVE; name: string; args: IDirectiveArg[] };

export type IDirectiveArg = IExpr | { kind: EKind.STRING; value: string };

export type IOperand =
  | { kind: EKind.REG; name: string }
  | { kind: EKind.MEM; offset: IExpr; base: string }
  | { kind: EKind.EXPR; expr: IExpr };

export type IExpr =
  | { kind: EKind.NUM; value: number }
  | { kind: EKind.SYM; name: string }
  | { kind: EKind.UNARY; op: "+" | "-"; expr: IExpr }
  | { kind: EKind.BINARY; op: "+" | "-" | "*" | "/"; left: IExpr; right: IExpr }
  | { kind: EKind.RELOC; op: string; arg: IExpr };

export type IParseErrorCause = {
  tokens: IToken[];
  got?: IToken;
  expected?: ETokenType;
  line: number;
};

type IParserState = {
  tokens: IToken[];
  idx: number;
  errors: Error[];
};

export const throwParseError = (tokens: IToken[], got?: IToken, expected?: ETokenType) => {
  return new Error("ASSEMBLER_PARSE_ERROR", {
    cause: { tokens, got, expected, line: got?.line ?? tokens[0]?.line ?? 0 } satisfies IParseErrorCause,
  });
};

export const stringifyParseError = (e: Error) => {
  if (e.message !== "ASSEMBLER_PARSE_ERROR") return e.toString();

  const cause = e.cause as IParseErrorCause;
  const line = cause?.line ?? 0;
  const got = cause?.got;

  if (got?.type === ETokenType.INVALID) {
    return `Invalid token (${got.value}) at line ${line}`;
  }

  if (cause?.expected !== undefined) {
    return `Expected ${ETokenType[cause.expected]} at line ${line}`;
  }

  return `Parse error at line ${line}`;
};

function pushParseError(state: IParserState, got?: IToken, expected?: ETokenType) {
  state.errors.push(throwParseError(state.tokens, got, expected));
}

function peek(state: IParserState) {
  return state.tokens[state.idx];
}

function atEnd(state: IParserState) {
  return state.idx >= state.tokens.length;
}

function advance(state: IParserState) {
  return state.tokens[state.idx++];
}

function skipToEnd(state: IParserState) {
  state.idx = state.tokens.length;
}

function expect(state: IParserState, type: ETokenType) {
  const t = peek(state);
  if (!t || t.type !== type) {
    pushParseError(state, t, type);
    return null;
  }

  return advance(state)!;
}

function groupByLine(tokens: IToken[]) {
  const map = new Map<number, IToken[]>();

  for (const t of tokens) {
    const row = map.get(t.line);
    if (row) row.push(t);
    else map.set(t.line, [t]);
  }

  return [...map.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

function parsePrimary(state: IParserState): IExpr | null {
  const t = peek(state);
  if (!t) {
    pushParseError(state);
    return null;
  }

  if (t.type === ETokenType.INVALID) {
    pushParseError(state, t);
    advance(state);
    return null;
  }

  if (t.type === ETokenType.IMMEDIATE) {
    advance(state);
    return { kind: EKind.NUM, value: t.value };
  }

  if (t.type === ETokenType.RELOC) {
    const op = advance(state)!.value as string;
    if (!expect(state, ETokenType.LPAREN)) return null;
    const arg = parseExpr(state);
    if (!arg || !expect(state, ETokenType.RPAREN)) return arg;
    return { kind: EKind.RELOC, op, arg };
  }

  if (t.type === ETokenType.IDENTIFIER || t.type === ETokenType.LABEL_REF) {
    advance(state);
    return { kind: EKind.SYM, name: t.value as string };
  }

  if (t.type === ETokenType.LPAREN) {
    advance(state);
    const expr = parseExpr(state);
    if (!expr || !expect(state, ETokenType.RPAREN)) return expr;
    return expr;
  }

  pushParseError(state, t);
  advance(state);
  return null;
}

function isAddOp(op: string): op is "+" | "-" {
  return op === "+" || op === "-";
}

function isMulOp(op: string): op is "*" | "/" {
  return op === "*" || op === "/";
}

function parseUnary(state: IParserState): IExpr | null {
  const t = peek(state);
  if (t?.type === ETokenType.OPERATOR && isAddOp(t.value as string)) {
    const op = advance(state)!.value as "+" | "-";
    const expr = parseUnary(state);
    if (!expr) return null;
    return { kind: EKind.UNARY, op, expr };
  }
  return parsePrimary(state);
}

function parseMulExpr(state: IParserState): IExpr | null {
  let left = parseUnary(state);
  if (!left) return null;

  while (peek(state)?.type === ETokenType.OPERATOR && isMulOp(peek(state)!.value as string)) {
    const op = advance(state)!.value as "*" | "/";
    const right = parseUnary(state);
    if (!right) return left;
    left = { kind: EKind.BINARY, op, left, right };
  }

  return left;
}

function parseExpr(state: IParserState): IExpr | null {
  let left = parseMulExpr(state);
  if (!left) return null;

  while (peek(state)?.type === ETokenType.OPERATOR && isAddOp(peek(state)!.value as string)) {
    const op = advance(state)!.value as "+" | "-";
    const right = parseMulExpr(state);
    if (!right) return left;
    left = { kind: EKind.BINARY, op, left, right };
  }

  return left;
}

function skipCommas(state: IParserState) {
  while (peek(state)?.type === ETokenType.COMMA) {
    advance(state);
  }
}

function isRegisterOperand(state: IParserState) {
  const t = peek(state);
  if (t?.type !== ETokenType.IDENTIFIER) return false;
  if (!REGISTER_NAMES.has((t.value as string).toLowerCase())) return false;

  const next = state.tokens[state.idx + 1];
  if (!next) return true;
  if (next.type === ETokenType.LPAREN) return false;
  if (next.type === ETokenType.OPERATOR) return false;
  return true;
}

function parseOperand(state: IParserState): IOperand | null {
  const t = peek(state);

  if (t?.type === ETokenType.LABEL_REF) {
    advance(state);
    return { kind: EKind.EXPR, expr: { kind: EKind.SYM, name: t.value as string } };
  }

  if (t?.type === ETokenType.IDENTIFIER && isRegisterOperand(state)) {
    const name = advance(state)!.value as string;
    return { kind: EKind.REG, name };
  }

  const saved = state.idx;
  const expr = parseExpr(state);
  if (!expr) {
    state.idx = saved;
    if (t) {
      pushParseError(state, t);
      advance(state);
    } else {
      pushParseError(state);
    }
    return null;
  }

  if (peek(state)?.type === ETokenType.LPAREN) {
    advance(state);
    const baseTok = expect(state, ETokenType.IDENTIFIER);
    if (!baseTok || !expect(state, ETokenType.RPAREN)) return null;
    return { kind: EKind.MEM, offset: expr, base: baseTok.value as string };
  }

  return { kind: EKind.EXPR, expr };
}

function parseInstruction(state: IParserState): IStatement | null {
  const mnemonicTok = peek(state);
  if (!mnemonicTok || mnemonicTok.type !== ETokenType.IDENTIFIER) {
    pushParseError(state, mnemonicTok);
    skipToEnd(state);
    return null;
  }

  // @ts-expect-error @todo dmeideimdiemdeikde
  const mnemonic = advance(state)!.value.toLowerCase();
  const operands: IOperand[] = [];

  while (!atEnd(state)) {
    skipCommas(state);
    const operand = parseOperand(state);
    if (!operand) {
      skipToEnd(state);
      break;
    }
    operands.push(operand);
  }

  return { kind: EKind.INSTRUCTION, mnemonic, operands };
}

function parseDirectiveExprs(state: IParserState): IExpr[] {
  const args: IExpr[] = [];

  while (!atEnd(state)) {
    skipCommas(state);
    const expr = parseExpr(state);
    if (!expr) {
      skipToEnd(state);
      break;
    }
    args.push(expr);
  }

  return args;
}

function parseDirectiveStrings(state: IParserState): IDirectiveArg[] {
  const args: IDirectiveArg[] = [];

  while (!atEnd(state)) {
    skipCommas(state);
    const t = peek(state);
    if (!t) break;

    if (t.type === ETokenType.STRING) {
      advance(state);
      args.push({ kind: EKind.STRING, value: t.value as string });
    } else {
      const expr = parseExpr(state);
      if (!expr) {
        skipToEnd(state);
        break;
      }
      args.push(expr);
    }
  }

  return args;
}

function parseDirective(state: IParserState): IStatement | null {
  const nameTok = peek(state);
  if (!nameTok || nameTok.type !== ETokenType.DIRECTIVE) {
    pushParseError(state, nameTok);
    skipToEnd(state);
    return null;
  }

  // @ts-expect-error @todo dmeideimdiemdeikde
  const name = advance(state)!.value.toLowerCase();

  switch (name) {
    case ".equ": {
      const symTok = expect(state, ETokenType.IDENTIFIER);
      if (!symTok) {
        skipToEnd(state);
        return null;
      }
      skipCommas(state);
      const value = parseExpr(state);
      if (!value) {
        skipToEnd(state);
        return null;
      }
      return { kind: EKind.DIRECTIVE, name, args: [{ kind: EKind.SYM, name: symTok.value as string }, value] };
    }

    case ".text":
    case ".data":
    case ".bss":
    case ".rodata":
      return { kind: EKind.DIRECTIVE, name, args: [] };

    case ".globl": // does nothing, just supress errors
    case ".global": // does nothing, just supress errors
    case ".byte":
    case ".half":
    case ".word":
    case ".zero":
    case ".space":
    case ".org":
    case ".align":
    case ".p2align":
    case ".option":
      return { kind: EKind.DIRECTIVE, name, args: parseDirectiveExprs(state) };

    case ".string":
    case ".ascii":
    case ".asciz":
      return { kind: EKind.DIRECTIVE, name, args: parseDirectiveStrings(state) };

    default:
      pushParseError(state, peek(state));
      skipToEnd(state);
      return null;
  }
}

function parseStatement(state: IParserState): IStatement | null {
  const t = peek(state);
  if (!t) {
    pushParseError(state);
    return null;
  }

  if (t.type === ETokenType.INVALID) {
    pushParseError(state, t);
    advance(state);
    skipToEnd(state);
    return null;
  }

  if (t.type === ETokenType.DIRECTIVE) {
    return parseDirective(state);
  }

  if (t.type === ETokenType.IDENTIFIER) {
    return parseInstruction(state);
  }

  pushParseError(state, t);
  skipToEnd(state);
  return null;
}

function parseLine(tokens: IToken[]): { line: ILine; errors: Error[] } {
  const state: IParserState = { tokens, idx: 0, errors: [] };
  const line = tokens[0].line;
  const origin = tokens[0].origin;

  let label: string | undefined;
  if (peek(state)?.type === ETokenType.LABEL_DECL) {
    label = (advance(state) as Extract<IToken, { value: string }>).value;
  }

  let stmt: IStatement | undefined;
  if (!atEnd(state)) {
    stmt = parseStatement(state) ?? undefined;

    if (!atEnd(state)) {
      pushParseError(state, peek(state));
      skipToEnd(state);
    }
  }

  return { line: { line, origin, label, stmt, hasErrors: state.errors.length > 0 }, errors: state.errors };
}

export function parse(tokens: IToken[]): IParseResult {
  const errors: Error[] = [];
  const lines = groupByLine(tokens).map((row) => {
    const result = parseLine(row);
    errors.push(...result.errors);
    return result.line;
  });

  return { program: { lines }, errors };
}

export function parseSource(code: string): IParseResult {
  return parse(tokenizer(preprocessor(code)));
}
