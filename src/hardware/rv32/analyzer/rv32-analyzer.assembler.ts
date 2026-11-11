import {
  rv_codec,
  rv_consts,
  rv_ext,
  rv_opcode,
  RV_OPCODE_DATA,
  rv_opcode_pseudo,
  rv_reg,
  rv_reg_f,
  rv_syscalls,
} from "../rv32.const";
import type { IDecodedRVInstruction } from "../rv32.types";
import {
  encodeBType,
  encodeIType,
  encodeJType,
  encodeR4Type,
  encodeRType,
  encodeRType_RV32F,
  encodeSType,
  encodeUType,
  splitHiLoS32,
  u32,
} from "../rv32.utils";
import type { TBinOp } from "./rv32-lexer.assembler";
import {
  EKind,
  parseSource,
  type IExpr,
  type ILine,
  type IOperand,
  type IParseResult,
  type IStatement,
} from "./rv32-parser.assembler";

const RV_RELOC_OPS = new Set(["hi", "lo", "pcrel_hi", "pcrel_lo"]);

const SHIFT_IMMEDIATE_OPS = new Set([rv_opcode.slli, rv_opcode.srli, rv_opcode.srai]);

export type IMemoryRegions = {
  PC_START: bigint;
  RODATA_START: bigint;
  DATA_START: bigint;
  BSS_START: bigint;
  STACK_START: bigint;
  STACK_END: bigint;
  FB_START: bigint;
  FB_END: bigint;
  KBD_STAT: bigint;
  KBD_DATA: bigint;
  STDIN_STAT: bigint;
  STDIN_DATA: bigint;
};

export type IEquEntry = IExpr;

export type ISymbolTable = {
  labels: Record<string, bigint>;
  equ: Record<string, IEquEntry>;
};

export type IPendingFixup =
  | { kind: "reloc"; op: string; sym: string }
  | { kind: "label"; sym: string; codec: rv_codec };

export type IAnalyzedUnit =
  | {
      kind: "instruction";
      line: number;
      parseLine: number;
      address: bigint;
      scope: string;
      decoded: IDecodedRVInstruction;
      pending?: IPendingFixup;
    }
  | { kind: "data"; line: number; address: bigint; width: 8 | 16 | 32; values: bigint[] }
  | { kind: "string"; line: number; address: bigint; bytes: number[]; zeroTerminated: boolean }
  | { kind: "reserve"; line: number; address: bigint; size: bigint };

export type IAnalyzeResult = {
  units: IAnalyzedUnit[];
  symbols: ISymbolTable;
  errors: Error[];
  warnings: Error[];
  optExplicitScreenUpdate: boolean;
};

export type ISemanticErrorCause = {
  line: number;
  message: string;
  symbol?: string;
};

type IAnalyzeCtx = {
  regions: IMemoryRegions;
  errors: Error[];
  warnings: Error[];
  equ: Record<string, IEquEntry>;
  labels: Record<string, bigint>;
  units: IAnalyzedUnit[];
  addr: bigint;
  scope: string;
  globalLabel: string;
  optExplicitScreenUpdate: boolean;
};

export const defaultMemoryRegions = (): IMemoryRegions => ({
  PC_START: 0x0000n,
  RODATA_START: 0x3000n,
  DATA_START: 0x4000n,
  BSS_START: 0x5000n,
  STACK_START: 0xc000n,
  STACK_END: 0xa710n,
  FB_START: 0x8000n,
  FB_END: 0xa70fn,
  KBD_STAT: 0x6000n,
  KBD_DATA: 0x6004n,
  STDIN_STAT: 0x6010n,
  STDIN_DATA: 0x6014n,
});

export const throwSemanticError = (line: number, message: string, symbol?: string) => {
  return new Error("ASSEMBLER_SEMANTIC_ERROR", { cause: { line, message, symbol } satisfies ISemanticErrorCause });
};

export const stringifySemanticError = (e: Error) => {
  if (e.message !== "ASSEMBLER_SEMANTIC_ERROR") return e.toString();
  const cause = e.cause as ISemanticErrorCause;
  if (cause.symbol) return `${cause.message} (${cause.symbol}) at line ${cause.line}`;
  return `${cause.message} at line ${cause.line}`;
};

function pushError(ctx: IAnalyzeCtx, line: number, message: string, symbol?: string) {
  ctx.errors.push(throwSemanticError(line, message, symbol));
}

export const createSemanticWarning = (line: number, message: string, symbol?: string) => {
  return new Error("ASSEMBLER_SEMANTIC_WARNING", { cause: { line, message, symbol } satisfies ISemanticErrorCause });
};

function pushWarning(ctx: IAnalyzeCtx, line: number, message: string, symbol?: string) {
  ctx.warnings.push(createSemanticWarning(line, message, symbol));
}

function immediateRange(op: rv_opcode, codec: rv_codec) {
  if (SHIFT_IMMEDIATE_OPS.has(op)) return { min: 0n, max: 31n };

  switch (codec) {
    case rv_codec.i:
    case rv_codec.s:
      return { min: -2048n, max: 2047n };
    case rv_codec.b:
      return { min: -4096n, max: 4094n };
    case rv_codec.j:
      return { min: -1048576n, max: 1048574n };
    default:
      return null;
  }
}

function dataRange(width: 8 | 16 | 32) {
  return { min: -(1n << BigInt(width - 1)), max: (1n << BigInt(width)) - 1n };
}

function exprSymbol(expr: IExpr): string | undefined {
  if (expr.kind === EKind.NUM) return String(expr.value);
  if (expr.kind === EKind.SYM) return expr.name;
  return undefined;
}

function checkImmediateRange(
  ctx: IAnalyzeCtx,
  line: number,
  op: rv_opcode,
  codec: rv_codec,
  value: bigint,
  symbol?: string,
  isAddress = false
) {
  const range = immediateRange(op, codec);
  if (!range || (value >= range.min && value <= range.max)) return;

  const name = RV_OPCODE_DATA[op].name;
  const bounds = `${range.min}..${range.max}`;

  if (SHIFT_IMMEDIATE_OPS.has(op)) {
    pushWarning(ctx, line, `Shift amount ${value} out of range for ${name} (${bounds})`, symbol);
    return;
  }

  if (codec === rv_codec.b || codec === rv_codec.j) {
    const kind = codec === rv_codec.b ? "Branch" : "Jump";

    pushWarning(ctx, line, `${kind} target out of reach for ${name}: offset ${value} (${bounds})`, symbol);

    return;
  }

  let message = `Immediate ${value} out of range for ${name} (${bounds}); encoded as ${BigInt.asIntN(12, value)}`;
  if (isAddress && symbol) {
    message += `. Use "la" to load the address of ${symbol}`;
  }

  pushWarning(ctx, line, message, symbol);
}

function checkDataRange(
  ctx: IAnalyzeCtx,
  line: number,
  directive: string,
  width: 8 | 16 | 32,
  value: bigint,
  symbol?: string
) {
  const range = dataRange(width);
  if (value >= range.min && value <= range.max) return;

  const stored = BigInt.asUintN(width, value);
  pushWarning(
    ctx,
    line,
    `Value ${value} out of range for ${directive} (${range.min}..${range.max}); stored as ${stored}`,
    symbol
  );
}

function numExpr(value: number | bigint): IExpr {
  return { kind: EKind.NUM, value: Number(value) };
}

function symExpr(name: string): IExpr {
  return { kind: EKind.SYM, name };
}

function regOp(name: string): IOperand {
  return { kind: EKind.REG, name };
}

function exprOp(expr: IExpr): IOperand {
  return { kind: EKind.EXPR, expr };
}

function operandToExpr(op: IOperand): IExpr {
  if (op.kind === EKind.EXPR) return op.expr;
  // @ts-expect-error @todo deimdiemdeikde
  return symExpr(op.name);
}

function resolveRegOperand(
  ctx: IAnalyzeCtx,
  op: IOperand | undefined,
  line: number,
  regKind: typeof rv_reg | typeof rv_reg_f = rv_reg
): number | null {
  if (!op) {
    return null;
  } else if (op.kind === EKind.REG) {
    return resolveRegister(ctx, op.name, line, regKind);
  } else if (op.kind === EKind.EXPR && op.expr.kind === EKind.SYM) {
    return resolveRegister(ctx, op.expr.name, line, regKind);
  }

  pushError(ctx, line, "Expected register operand");

  return null;
}

function immExprFromOperand(op: IOperand | undefined): IExpr {
  if (!op) return numExpr(0);
  return operandToExpr(op);
}

function createDecoded(op: rv_opcode): IDecodedRVInstruction {
  const data = RV_OPCODE_DATA[op];
  return {
    bytecode: 0n,
    codec: data.codec,
    _op: op,
    opcode: data.opcode ?? 0,
    imm: 0n,
    rd: rv_reg.zero,
    rs1: rv_reg.zero,
    rs2: rv_reg.zero,
    rs3: rv_reg.zero,
    rm: 0,
  };
}

function toBytecode(dec: IDecodedRVInstruction): bigint {
  const op = dec._op;
  const rd = BigInt(dec.rd);
  const rs1 = BigInt(dec.rs1);
  const rs2 = BigInt(dec.rs2);
  let imm = dec.imm;
  if (op === rv_opcode.ebreak && imm === 0n) imm = 1n;

  const codec = RV_OPCODE_DATA[op].codec;
  const ext = RV_OPCODE_DATA[op].extension;

  switch (codec) {
    case rv_codec.r:
      if (ext === rv_ext.RV32F) return u32(encodeRType_RV32F(op, rd, rs1, rs2));
      return u32(encodeRType(op, rd, rs1, rs2));
    case rv_codec.i:
      return u32(encodeIType(op, rd, rs1, imm));
    case rv_codec.s:
      return u32(encodeSType(op, rs1, rs2, imm));
    case rv_codec.b:
      return u32(encodeBType(op, rs1, rs2, imm));
    case rv_codec.u:
      return u32(encodeUType(op, rd, imm));
    case rv_codec.j:
      return u32(encodeJType(op, rd, imm));
    case rv_codec.r4:
      return u32(encodeR4Type(op, rd, rs1, rs2, BigInt(dec.rs3), BigInt(dec.rm)));
    default:
      return 0n;
  }
}

function builtinValue(ctx: IAnalyzeCtx, name: string): bigint | undefined {
  const map: Record<string, bigint> = {
    PC_START: ctx.regions.PC_START,
    RODATA_START: ctx.regions.RODATA_START,
    DATA_START: ctx.regions.DATA_START,
    BSS_START: ctx.regions.BSS_START,
    STACK_START: ctx.regions.STACK_START,
    STACK_END: ctx.regions.STACK_END,
    FB_START: ctx.regions.FB_START,
    FB_END: ctx.regions.FB_END,
    KBD_STAT: ctx.regions.KBD_STAT,
    KBD_DATA: ctx.regions.KBD_DATA,
    STDIN_STAT: ctx.regions.STDIN_STAT,
    STDIN_DATA: ctx.regions.STDIN_DATA,
    SYSCALL_PRINT_UINT: BigInt(rv_syscalls.syscall_print_uint),
    SYSCALL_PRINT_INT: BigInt(rv_syscalls.syscall_print_int),
    SYSCALL_PRINT_STRING: BigInt(rv_syscalls.syscall_print_string),
    SYSCALL_PRINT_CHAR: BigInt(rv_syscalls.syscall_print_char),
    SYSCALL_PRINT_FLOAT: BigInt(rv_syscalls.syscall_print_float),
    SYSCALL_PRINTF: BigInt(rv_syscalls.syscall_printf),
    SYSCALL_READ_INT: BigInt(rv_syscalls.syscall_read_int),
    SYSCALL_READ_STRING: BigInt(rv_syscalls.syscall_read_string),
    SYSCALL_READ_CHAR: BigInt(rv_syscalls.syscall_read_char),
    SYSCALL_READ_FLOAT: BigInt(rv_syscalls.syscall_read_float),
    SYSCALL_UPDATE_SCREEN: BigInt(rv_syscalls.syscall_update_screen),
    SYSCALL_FILL_SCREEN: BigInt(rv_syscalls.syscall_fill_screen),
    SYSCALL_RANDOM_BYTES: BigInt(rv_syscalls.syscall_random_bytes),
    OPTION_EXPLICIT_SCREEN_UPDATE: 0xf001n,
  };
  return map[name];
}

function qualifyLabel(name: string, scope: string) {
  return name.startsWith(".") ? scope + name : name;
}

function followEquExpr(ctx: IAnalyzeCtx, name: string, line: number, seen = new Set<string>()): IExpr | null {
  if (seen.has(name)) {
    pushError(ctx, line, "Circular .equ declaration", name);
    return null;
  }

  seen.add(name);

  const builtin = builtinValue(ctx, name);
  if (builtin !== undefined) return numExpr(builtin);

  const entry = ctx.equ[name];
  if (!entry) return symExpr(name);

  if (entry.kind === EKind.SYM) {
    const next = followEquExpr(ctx, entry.name, line, seen);
    return next;
  }

  return entry;
}

function evalBinaryOp(ctx: IAnalyzeCtx, op: TBinOp, left: bigint, right: bigint, line: number): bigint | null {
  switch (op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      if (right === 0n) {
        pushError(ctx, line, "Division by zero");
        return null;
      }

      return left / right;
  }
}

function evalExpr(ctx: IAnalyzeCtx, expr: IExpr, line: number): bigint | null {
  switch (expr.kind) {
    case EKind.NUM:
      return BigInt(expr.value);

    case EKind.SYM: {
      const resolved = followEquExpr(ctx, expr.name, line);
      if (!resolved) return null;
      if (resolved.kind === EKind.SYM) {
        const labelName = qualifyLabel(resolved.name, ctx.scope);
        const labelAddr = ctx.labels[labelName];
        if (labelAddr !== undefined) return labelAddr;
        pushError(ctx, line, "Undeclared symbol", expr.name);
        return null;
      }
      return evalExpr(ctx, resolved, line);
    }

    case EKind.UNARY: {
      const inner = evalExpr(ctx, expr.expr, line);
      if (inner === null) return null;
      return expr.op === "-" ? -inner : inner;
    }

    case EKind.BINARY: {
      const left = evalExpr(ctx, expr.left, line);
      const right = evalExpr(ctx, expr.right, line);
      if (left === null || right === null) return null;
      return expr.op === "+" ? left + right : left - right;
    }

    case EKind.RELOC:
      pushError(ctx, line, "Relocation not allowed in this context");
      return null;
  }
}

function resolveConstantOnly(ctx: IAnalyzeCtx, expr: IExpr, line: number): bigint | null {
  if (expr.kind === EKind.NUM) return BigInt(expr.value);

  if (expr.kind === EKind.SYM) {
    const resolved = followEquExpr(ctx, expr.name, line);
    if (!resolved || resolved.kind === EKind.SYM) return null;
    return evalExpr(ctx, resolved, line);
  }

  if (expr.kind === EKind.UNARY) {
    const inner = resolveConstantOnly(ctx, expr.expr, line);
    if (inner === null) return null;
    return expr.op === "-" ? -inner : inner;
  }

  if (expr.kind === EKind.BINARY) {
    const left = resolveConstantOnly(ctx, expr.left, line);
    const right = resolveConstantOnly(ctx, expr.right, line);
    if (left === null || right === null) return null;
    return evalBinaryOp(ctx, expr.op, left, right, line);
  }

  return null;
}

function resolveNumeric(ctx: IAnalyzeCtx, expr: IExpr, line: number): bigint | null {
  const val = resolveConstantOnly(ctx, expr, line);
  if (val !== null) return val;

  if (expr.kind === EKind.SYM) {
    const labelName = qualifyLabel(expr.name, ctx.scope);
    if (ctx.labels[labelName] !== undefined) {
      return ctx.labels[labelName];
    }
    pushError(ctx, line, "Undeclared symbol", expr.name);
  }

  return null;
}

function lookupRegister(name: string, regKind: typeof rv_reg | typeof rv_reg_f = rv_reg): number | undefined {
  const key = name.toLowerCase() as keyof typeof rv_reg;
  // @ts-expect-error @todo type this
  const value = regKind[key];
  return typeof value === "number" ? value : undefined;
}

function resolveRegister(
  ctx: IAnalyzeCtx,
  name: string,
  line: number,
  regKind: typeof rv_reg | typeof rv_reg_f = rv_reg
): number | null {
  const resolved = followEquExpr(ctx, name, line);
  if (!resolved) return null;

  if (resolved.kind === EKind.NUM) {
    pushError(ctx, line, "Expected register, got numeric constant", name);
    return null;
  }

  const regName = resolved.kind === EKind.SYM ? resolved.name : name;
  const reg = lookupRegister(regName, regKind);
  if (reg === undefined) {
    pushError(ctx, line, "Invalid register", regName);
    return null;
  }

  return reg;
}

function relocImmediate(op: string, symbolVal: bigint, instAddr: bigint): bigint {
  switch (op) {
    case "hi":
      return splitHiLoS32(symbolVal).hi;
    case "lo":
      return splitHiLoS32(symbolVal).lo;
    case "pcrel_hi":
      return splitHiLoS32(symbolVal - instAddr).hi;
    case "pcrel_lo":
      return splitHiLoS32(symbolVal - (instAddr - 4n)).lo;
    default:
      return 0n;
  }
}

type IImmResult = { value: bigint; pending?: IPendingFixup };

function resolveImm(ctx: IAnalyzeCtx, expr: IExpr, line: number, pc: bigint, codec: rv_codec): IImmResult | null {
  if (expr.kind === EKind.RELOC) {
    if (!RV_RELOC_OPS.has(expr.op)) {
      pushError(ctx, line, "Unknown relocation operator", expr.op);
      return null;
    }

    const arg = expr.arg;
    if (arg.kind === EKind.NUM) {
      return { value: relocImmediate(expr.op, BigInt(arg.value), pc) };
    }

    if (arg.kind === EKind.SYM) {
      const num = resolveConstantOnly(ctx, arg, line);
      if (num !== null) return { value: relocImmediate(expr.op, num, pc) };

      const labelName = qualifyLabel(arg.name, ctx.scope);
      const labelAddr = ctx.labels[labelName];
      if (labelAddr !== undefined) return { value: relocImmediate(expr.op, labelAddr, pc) };

      return {
        value: 0n,
        pending: { kind: "reloc", op: expr.op, sym: labelName },
      };
    }

    pushError(ctx, line, "Invalid relocation argument");
    return null;
  }

  if (expr.kind === EKind.SYM) {
    const num = resolveConstantOnly(ctx, expr, line);
    if (num !== null) {
      if (codec === rv_codec.u) return { value: (num >> 12n) & 0xfffffn };
      return { value: num };
    }

    const labelName = qualifyLabel(expr.name, ctx.scope);
    const labelAddr = ctx.labels[labelName];
    if (labelAddr !== undefined) {
      if (codec === rv_codec.j || codec === rv_codec.b) return { value: labelAddr - pc };
      if (codec === rv_codec.u) return { value: (labelAddr >> 12n) & 0xfffffn };
      if (codec === rv_codec.i) return { value: labelAddr };
      return { value: labelAddr };
    }

    return { value: 0n, pending: { kind: "label", sym: labelName, codec } };
  }

  const num = resolveConstantOnly(ctx, expr, line);
  if (num === null && expr.kind !== EKind.NUM) {
    const fallback = evalExpr(ctx, expr, line);

    if (fallback === null) return null;
    if (codec === rv_codec.j || codec === rv_codec.b) return { value: fallback - pc };
    if (codec === rv_codec.u) return { value: (fallback >> 12n) & 0xfffffn };

    return { value: fallback };
  }

  if (num === null) return null;

  if (codec === rv_codec.j || codec === rv_codec.b) {
    return { value: num - pc, pending: undefined };
  }

  if (codec === rv_codec.u) return { value: (num >> 12n) & 0xfffffn };

  return { value: num };
}

function alignAddr(addr: bigint) {
  return (addr + 3n) & ~0x3n;
}

function emitInstruction(
  ctx: IAnalyzeCtx,
  origin: number,
  parseLine: number,
  decoded: IDecodedRVInstruction,
  pending?: IPendingFixup
) {
  ctx.addr = alignAddr(ctx.addr);
  decoded.bytecode = toBytecode(decoded);
  ctx.units.push({
    kind: "instruction",
    line: origin,
    parseLine,
    address: ctx.addr,
    scope: ctx.scope,
    decoded,
    pending,
  });
  ctx.addr += 4n;
}

function lowerPseudo(stmt: IStatement): IStatement[] | null {
  if (stmt.kind !== EKind.INSTRUCTION) return null;

  const { mnemonic, operands: ops } = stmt;

  switch (mnemonic) {
    case "nop":
      return [
        { kind: EKind.INSTRUCTION, mnemonic: "addi", operands: [regOp("zero"), regOp("zero"), exprOp(numExpr(0))] },
      ];
    case "mv":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "addi", operands: [ops[0], ops[1], exprOp(numExpr(0))] }];
    case "not":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "xori", operands: [ops[0], ops[1], exprOp(numExpr(-1))] }];
    case "neg":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "sub", operands: [ops[0], regOp("zero"), ops[1]] }];
    case "seqz":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "sltiu", operands: [ops[0], ops[1], exprOp(numExpr(1))] }];
    case "snez":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "sltu", operands: [ops[0], regOp("zero"), ops[1]] }];
    case "sltz":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "slt", operands: [ops[0], ops[1], regOp("zero")] }];
    case "sgtz":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "slt", operands: [ops[0], regOp("zero"), ops[1]] }];
    case "ret":
      return [
        { kind: EKind.INSTRUCTION, mnemonic: "jalr", operands: [regOp("zero"), regOp("ra"), exprOp(numExpr(0))] },
      ];
    case "j":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "jal", operands: [regOp("zero"), ops[0]] }];
    case "beqz":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "beq", operands: [ops[0], regOp("zero"), ops[1]] }];
    case "bnez":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "bne", operands: [ops[0], regOp("zero"), ops[1]] }];
    case "blez":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "bge", operands: [regOp("zero"), ops[0], ops[1]] }];
    case "bgez":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "bge", operands: [ops[0], regOp("zero"), ops[1]] }];
    case "bltz":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "blt", operands: [regOp("zero"), ops[0], ops[1]] }];
    case "bgtz":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "blt", operands: [regOp("zero"), ops[0], ops[1]] }];
    case "bgt":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "blt", operands: [ops[1], ops[0], ops[2]] }];
    case "ble":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "bge", operands: [ops[1], ops[0], ops[2]] }];
    case "bgtu":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "bltu", operands: [ops[1], ops[0], ops[2]] }];
    case "bleu":
      return [{ kind: EKind.INSTRUCTION, mnemonic: "bgeu", operands: [ops[1], ops[0], ops[2]] }];
    case "la":
      return [
        {
          kind: EKind.INSTRUCTION,
          mnemonic: "auipc",
          operands: [ops[0], exprOp({ kind: EKind.RELOC, op: "hi", arg: operandToExpr(ops[1]) })],
        },
        {
          kind: EKind.INSTRUCTION,
          mnemonic: "addi",
          operands: [ops[0], ops[0], exprOp({ kind: EKind.RELOC, op: "lo", arg: operandToExpr(ops[1]) })],
        },
      ];
    default:
      return null;
  }
}

function analyzeInstructionStmt(ctx: IAnalyzeCtx, origin: number, parseLine: number, stmt: IStatement) {
  if (stmt.kind !== EKind.INSTRUCTION) return;

  let statements: IStatement[] = [stmt];

  if (stmt.mnemonic === "li" && stmt.operands.length >= 2) {
    const immExpr = operandToExpr(stmt.operands[1]);
    const imm = evalExpr(ctx, immExpr, origin);
    if (imm !== null && imm >= -2048n && imm <= 2047n) {
      statements = [
        {
          kind: EKind.INSTRUCTION,
          mnemonic: "addi",
          operands: [stmt.operands[0], regOp("zero"), exprOp(numExpr(imm))],
        },
      ];
    } else {
      statements = [
        {
          kind: EKind.INSTRUCTION,
          mnemonic: "lui",
          operands: [stmt.operands[0], exprOp({ kind: EKind.RELOC, op: "hi", arg: immExpr })],
        },
        {
          kind: EKind.INSTRUCTION,
          mnemonic: "addi",
          operands: [stmt.operands[0], stmt.operands[0], exprOp({ kind: EKind.RELOC, op: "lo", arg: immExpr })],
        },
      ];
    }
  } else if (stmt.mnemonic === "call") {
    const targetExpr = operandToExpr(stmt.operands[0]);
    const rd = stmt.operands[1] ?? regOp("ra");
    statements = [
      {
        kind: EKind.INSTRUCTION,
        mnemonic: "auipc",
        operands: [rd, exprOp({ kind: EKind.RELOC, op: "pcrel_hi", arg: targetExpr })],
      },
      {
        kind: EKind.INSTRUCTION,
        mnemonic: "jalr",
        operands: [rd, rd, exprOp({ kind: EKind.RELOC, op: "pcrel_lo", arg: targetExpr })],
      },
    ];
  } else {
    const opKey = stmt.mnemonic as keyof typeof rv_opcode;
    const opcode = rv_opcode[opKey];
    const data = opcode !== undefined ? RV_OPCODE_DATA[opcode] : undefined;

    if (!data?.opcode) {
      const lowered = lowerPseudo(stmt);
      if (lowered) {
        statements = lowered;
      } else if (stmt.mnemonic in rv_opcode_pseudo) {
        pushError(ctx, origin, "Unsupported pseudo instruction", stmt.mnemonic);
        return;
      } else {
        pushError(ctx, origin, "Unknown instruction", stmt.mnemonic);
        return;
      }
    }
  }

  for (const s of statements) {
    analyzeRealInstruction(ctx, origin, parseLine, s);
  }
}

function analyzeRealInstruction(ctx: IAnalyzeCtx, origin: number, parseLine: number, stmt: IStatement) {
  if (stmt.kind !== EKind.INSTRUCTION) return;

  const opKey = stmt.mnemonic as keyof typeof rv_opcode;
  const opcode = rv_opcode[opKey];
  const data = opcode !== undefined ? RV_OPCODE_DATA[opcode] : undefined;
  if (!data?.opcode) return;

  const dec = createDecoded(opcode);
  const pc = alignAddr(ctx.addr);
  const ops = stmt.operands;
  let pending: IPendingFixup | undefined;

  const setImm = (expr: IExpr) => {
    const result = resolveImm(ctx, expr, origin, pc, dec.codec);
    if (!result) return false;

    if (!result.pending && expr.kind !== EKind.RELOC) {
      const isAddress = expr.kind === EKind.SYM && ctx.labels[qualifyLabel(expr.name, ctx.scope)] !== undefined;
      checkImmediateRange(ctx, origin, opcode, dec.codec, result.value, exprSymbol(expr), isAddress);
    }

    if (dec.codec === rv_codec.i || dec.codec === rv_codec.s) {
      dec.imm = result.value & 0xfffn;
    } else if (dec.codec === rv_codec.u) {
      dec.imm = result.value & 0xfffffn;
    } else {
      dec.imm = result.value;
    }

    pending = result.pending;

    return true;
  };

  if (data.extension === rv_ext.RV32I || data.extension === rv_ext.RV32M) {
    switch (dec.codec) {
      case rv_codec.r: {
        const rd = resolveRegOperand(ctx, ops[0], origin);
        const rs1 = resolveRegOperand(ctx, ops[1], origin);
        const rs2 = resolveRegOperand(ctx, ops[2], origin);
        if (rd === null || rs1 === null || rs2 === null) return;
        dec.rd = rd;
        dec.rs1 = rs1;
        dec.rs2 = rs2;
        break;
      }
      case rv_codec.i: {
        if (opcode === rv_opcode.ecall || opcode === rv_opcode.ebreak) break;
        if (ops[1]?.kind === EKind.MEM) {
          const rd = resolveRegOperand(ctx, ops[0], origin);
          const rs1 = resolveRegister(ctx, ops[1].base, origin);
          if (rd === null || rs1 === null || !setImm(ops[1].offset)) return;
          dec.rd = rd;
          dec.rs1 = rs1;
        } else {
          const rd = resolveRegOperand(ctx, ops[0], origin);
          const rs1 = resolveRegOperand(ctx, ops[1], origin);
          if (rd === null || rs1 === null || !setImm(immExprFromOperand(ops[2]))) return;
          dec.rd = rd;
          dec.rs1 = rs1;
        }
        break;
      }
      case rv_codec.s: {
        if (ops[1]?.kind === EKind.MEM) {
          const rs2 = resolveRegOperand(ctx, ops[0], origin);
          const rs1 = resolveRegister(ctx, ops[1].base, origin);
          if (rs2 === null || rs1 === null || !setImm(ops[1].offset)) return;
          dec.rs2 = rs2;
          dec.rs1 = rs1;
        } else if (ops[0]?.kind === EKind.MEM) {
          const rs1 = resolveRegister(ctx, ops[0].base, origin);
          const rs2 = resolveRegOperand(ctx, ops[1], origin);
          if (rs1 === null || rs2 === null || !setImm(ops[0].offset)) return;
          dec.rs1 = rs1;
          dec.rs2 = rs2;
        } else {
          const rs2 = resolveRegOperand(ctx, ops[0], origin);
          const rs1 = resolveRegOperand(ctx, ops[1], origin);
          if (rs2 === null || rs1 === null || !setImm(immExprFromOperand(ops[2]))) return;
          dec.rs2 = rs2;
          dec.rs1 = rs1;
        }
        break;
      }
      case rv_codec.b: {
        const rs1 = resolveRegOperand(ctx, ops[0], origin);
        const rs2 = resolveRegOperand(ctx, ops[1], origin);
        if (rs1 === null || rs2 === null || !setImm(immExprFromOperand(ops[2]))) return;
        dec.rs1 = rs1;
        dec.rs2 = rs2;
        break;
      }
      case rv_codec.u:
      case rv_codec.j: {
        const rd = resolveRegOperand(ctx, ops[0], origin);
        if (rd === null || !setImm(immExprFromOperand(ops[1]))) return;
        dec.rd = rd;
        break;
      }
    }
  } else if (data.extension === rv_ext.RV32F) {
    switch (dec.codec) {
      case rv_codec.r: {
        const rdKind = [
          rv_opcode["fcvt.w.s"],
          rv_opcode["fcvt.wu.s"],
          rv_opcode["fmv.x.w"],
          rv_opcode["feq.s"],
          rv_opcode["flt.s"],
          rv_opcode["fle.s"],
          rv_opcode["fclass.s"],
        ].includes(opcode)
          ? rv_reg
          : rv_reg_f;
        const rs1Kind = [rv_opcode["fmv.w.x"], rv_opcode["fcvt.s.w"], rv_opcode["fcvt.s.wu"]].includes(opcode)
          ? rv_reg
          : rv_reg_f;
        const rd = resolveRegOperand(ctx, ops[0], origin, rdKind);
        const rs1 = resolveRegOperand(ctx, ops[1], origin, rs1Kind);
        if (rd === null || rs1 === null) return;
        dec.rd = rd;
        dec.rs1 = rs1;
        if (
          [
            rv_opcode["fsqrt.s"],
            rv_opcode["fcvt.w.s"],
            rv_opcode["fcvt.wu.s"],
            rv_opcode["fmv.x.w"],
            rv_opcode["fclass.s"],
            rv_opcode["fcvt.s.w"],
            rv_opcode["fcvt.s.wu"],
            rv_opcode["fmv.w.x"],
          ].includes(opcode)
        ) {
          dec.rs2 = 0;
        } else {
          const rs2 = resolveRegOperand(ctx, ops[2], origin, rv_reg_f);
          if (rs2 === null) return;
          dec.rs2 = rs2;
        }
        break;
      }
      case rv_codec.i: {
        const rd = resolveRegOperand(ctx, ops[0], origin, rv_reg_f);
        if (ops[1]?.kind === EKind.MEM) {
          const rs1 = resolveRegister(ctx, ops[1].base, origin);
          if (rd === null || rs1 === null || !setImm(ops[1].offset)) return;
          dec.rd = rd;
          dec.rs1 = rs1;
        } else {
          const rs1 = resolveRegOperand(ctx, ops[1], origin);
          if (rd === null || rs1 === null || !setImm(immExprFromOperand(ops[2]))) return;
          dec.rd = rd;
          dec.rs1 = rs1;
        }
        break;
      }
      case rv_codec.s: {
        if (ops[1]?.kind === EKind.MEM) {
          const rs2 = resolveRegOperand(ctx, ops[0], origin, rv_reg_f);
          const rs1 = resolveRegister(ctx, ops[1].base, origin);
          if (rs2 === null || rs1 === null || !setImm(ops[1].offset)) return;
          dec.rs2 = rs2;
          dec.rs1 = rs1;
        } else {
          const rs2 = resolveRegOperand(ctx, ops[0], origin, rv_reg_f);
          const rs1 = resolveRegOperand(ctx, ops[1], origin);
          if (rs2 === null || rs1 === null || !setImm(immExprFromOperand(ops[2]))) return;
          dec.rs2 = rs2;
          dec.rs1 = rs1;
        }
        break;
      }
      case rv_codec.r4: {
        const rd = resolveRegOperand(ctx, ops[0], origin, rv_reg_f);
        const rs1 = resolveRegOperand(ctx, ops[1], origin, rv_reg_f);
        const rs2 = resolveRegOperand(ctx, ops[2], origin, rv_reg_f);
        const rs3 = resolveRegOperand(ctx, ops[3], origin, rv_reg_f);
        if (rd === null || rs1 === null || rs2 === null || rs3 === null) return;
        dec.rd = rd;
        dec.rs1 = rs1;
        dec.rs2 = rs2;
        dec.rs3 = rs3;
        // @todo rounding mode
        dec.rm = 0b111;
        break;
      }
    }
  }

  emitInstruction(ctx, origin, parseLine, dec, pending);
}

function analyzeDirective(ctx: IAnalyzeCtx, line: number, stmt: IStatement) {
  if (stmt.kind !== EKind.DIRECTIVE) return;

  switch (stmt.name) {
    case ".text":
      ctx.addr = ctx.regions.PC_START;
      return;
    case ".data":
      ctx.addr = ctx.regions.DATA_START;
      return;
    case ".rodata":
      ctx.addr = ctx.regions.RODATA_START;
      return;
    case ".bss":
      ctx.addr = ctx.regions.BSS_START;
      return;
    case ".equ": {
      const nameArg = stmt.args[0];
      const valueArg = stmt.args[1];

      if (!nameArg || nameArg.kind !== EKind.SYM || !valueArg || valueArg.kind === EKind.STRING) {
        pushError(ctx, line, "Invalid .equ directive");
        return;
      } else if (ctx.equ[nameArg.name] !== undefined) {
        pushError(ctx, line, "Symbol already defined", nameArg.name);
        return;
      }

      ctx.equ[nameArg.name] = valueArg;
      return;
    }
    case ".byte":
    case ".half":
    case ".word": {
      const width = stmt.name === ".byte" ? 8 : stmt.name === ".half" ? 16 : 32;
      const values: bigint[] = [];

      for (const arg of stmt.args) {
        if (arg.kind === EKind.STRING) {
          pushError(ctx, line, "Expected numeric value in data directive");

          continue;
        }

        const val = resolveNumeric(ctx, arg, line);
        if (val === null) continue;

        checkDataRange(ctx, line, stmt.name, width, val, exprSymbol(arg));
        values.push(val);
      }

      if (values.length === 0) return;

      ctx.units.push({ kind: "data", line, address: ctx.addr, width: width as 8 | 16 | 32, values });
      ctx.addr += BigInt(values.length * (width / 8));

      return;
    }
    case ".space": {
      const size = stmt.args[0] && stmt.args[0].kind !== EKind.STRING ? resolveNumeric(ctx, stmt.args[0], line) : null;

      if (size === null) {
        pushError(ctx, line, "Invalid .space directive");
        return;
      }

      ctx.units.push({ kind: "reserve", line, address: ctx.addr, size });
      ctx.addr += size;

      return;
    }
    case ".org": {
      const addr = stmt.args[0] && stmt.args[0].kind !== EKind.STRING ? resolveNumeric(ctx, stmt.args[0], line) : null;

      if (addr === null) {
        pushError(ctx, line, "Invalid .org directive");
        return;
      }

      ctx.addr = addr;
      return;
    }
    case ".align":
    case ".p2align": {
      const power = stmt.args[0] && stmt.args[0].kind !== EKind.STRING ? resolveNumeric(ctx, stmt.args[0], line) : 2n;
      const fill = stmt.args[1] && stmt.args[1].kind !== EKind.STRING ? resolveNumeric(ctx, stmt.args[1], line) : null;
      const maxPad =
        stmt.args[2] && stmt.args[2].kind !== EKind.STRING ? resolveNumeric(ctx, stmt.args[2], line) : null;

      if (power === null) {
        pushError(ctx, line, "Invalid .align directive");
        return;
      }

      const alignment = 1n << power;
      const aligned = (ctx.addr + alignment - 1n) & ~(alignment - 1n);
      const padding = aligned - ctx.addr;
      if (padding > 0n && (maxPad === null || padding <= maxPad)) {
        if (fill !== null) {
          const bytes = Array(Number(padding)).fill(Number(fill & 0xffn));
          ctx.units.push({ kind: "string", line, address: ctx.addr, bytes, zeroTerminated: false });
        }
        ctx.addr = aligned;
      }

      return;
    }
    case ".string":
    case ".ascii":
    case ".asciz": {
      const arg = stmt.args[0];

      if (!arg || arg.kind !== EKind.STRING) {
        pushError(ctx, line, "Expected string literal");
        return;
      }

      const bytes = [...arg.value].map((c) => c.charCodeAt(0));

      ctx.units.push({
        kind: "string",
        line,
        address: ctx.addr,
        bytes,
        zeroTerminated: stmt.name !== ".ascii",
      });

      ctx.addr += BigInt(bytes.length + (stmt.name === ".ascii" ? 0 : 1));

      return;
    }
    case ".option": {
      const arg = stmt.args[0];
      if (arg?.kind === EKind.SYM && arg.name === rv_consts.OPTION_EXPLICIT_SCREEN_UPDATE) {
        ctx.optExplicitScreenUpdate = true;
        return;
      }

      pushError(ctx, line, "Unknown .option value");
      return;
    }
    default:
      pushError(ctx, line, "Unknown directive", stmt.name);
  }
}

function registerLabel(ctx: IAnalyzeCtx, line: number, rawLabel: string) {
  const name = qualifyLabel(rawLabel, ctx.scope);
  if (ctx.labels[name] !== undefined) {
    pushError(ctx, line, "Label already defined", rawLabel);
    return;
  }

  ctx.labels[name] = alignAddr(ctx.addr);

  if (!rawLabel.startsWith(".")) {
    ctx.globalLabel = rawLabel;
    ctx.scope = rawLabel;
  }
}

function analyzeLine(ctx: IAnalyzeCtx, sourceLine: ILine) {
  if (sourceLine.label) {
    registerLabel(ctx, sourceLine.origin, sourceLine.label);
  }

  if (!sourceLine.stmt) return;

  if (sourceLine.stmt.kind === EKind.DIRECTIVE) {
    analyzeDirective(ctx, sourceLine.origin, sourceLine.stmt);
    return;
  }

  analyzeInstructionStmt(ctx, sourceLine.origin, sourceLine.line, sourceLine.stmt);
}

function resolvePendingFixups(ctx: IAnalyzeCtx) {
  for (const unit of ctx.units) {
    if (unit.kind !== "instruction" || !unit.pending) continue;

    const { decoded, pending, address } = unit;
    const line = unit.line;

    if (pending.kind === "reloc") {
      const symAddr = ctx.labels[pending.sym];
      if (symAddr === undefined) {
        pushError(ctx, line, "Undeclared label in relocation", pending.sym);
        continue;
      }
      decoded.imm =
        decoded.codec === rv_codec.u
          ? relocImmediate(pending.op, symAddr, address) & 0xfffffn
          : relocImmediate(pending.op, symAddr, address) & 0xfffn;
    } else {
      const labelAddr = ctx.labels[pending.sym];
      if (labelAddr === undefined) {
        pushError(ctx, line, "Undeclared label", pending.sym);
        continue;
      }
      if (pending.codec === rv_codec.j || pending.codec === rv_codec.b) {
        decoded.imm = labelAddr - address;
      } else if (pending.codec === rv_codec.u) {
        decoded.imm = (labelAddr >> 12n) & 0xfffffn;
      } else if (pending.codec === rv_codec.i) {
        decoded.imm = labelAddr;
      }

      if (pending.codec !== rv_codec.u) {
        const isLocal = unit.scope !== "" && pending.sym.startsWith(`${unit.scope}.`);
        const symbol = isLocal ? pending.sym.slice(unit.scope.length) : pending.sym;
        checkImmediateRange(ctx, line, decoded._op, pending.codec, decoded.imm, symbol, pending.codec === rv_codec.i);
      }
    }

    decoded.bytecode = toBytecode(decoded);
    unit.pending = undefined;
  }
}

export function analyze(parseResult: IParseResult): IAnalyzeResult {
  const regions = defaultMemoryRegions();

  const ctx: IAnalyzeCtx = {
    regions,
    errors: [],
    warnings: [],
    equ: {},
    labels: {},
    units: [],
    addr: regions.PC_START,
    scope: "",
    globalLabel: "",
    optExplicitScreenUpdate: false,
  };

  for (const line of parseResult.program.lines) {
    analyzeLine(ctx, line);
  }

  resolvePendingFixups(ctx);

  return {
    units: ctx.units,
    symbols: { labels: ctx.labels, equ: ctx.equ },
    errors: [...parseResult.errors, ...ctx.errors],
    warnings: ctx.warnings,
    optExplicitScreenUpdate: ctx.optExplicitScreenUpdate,
  };
}

export function analyzeSource(code: string): IAnalyzeResult {
  return analyze(parseSource(code));
}
