import { describe, expect, test } from "vitest";
import { tokenizer } from "../../hardware/rv32/analyzer/rv32-lexer.assembler";
import { EKind, parse, parseSource, stringifyParseError } from "../../hardware/rv32/analyzer/rv32-parser.assembler";
import type { ISourceLine } from "../../hardware/rv32/analyzer/rv32-pre.assembler";

function toSource(lines: string[]): ISourceLine[] {
  return lines.map((line, i) => ({ line, number: i + 1, origin: i + 1 }));
}

/** Parse a single line without running the macro preprocessor. */
function parseRaw(line: string, meta: Partial<ISourceLine> = {}) {
  const source: ISourceLine = {
    line,
    number: meta.number ?? 1,
    origin: meta.origin ?? meta.number ?? 1,
  };
  const { program, errors } = parse(tokenizer([source]));

  return { line: program.lines[0], errors };
}

function parseRawSource(lines: string[]) {
  return parse(tokenizer(toSource(lines)));
}

function inst(line: string) {
  const { line: parsed, errors } = parseRaw(line);

  expect(errors).toEqual([]);
  expect(parsed.stmt?.kind).toBe(EKind.INSTRUCTION);

  return parsed.stmt as Extract<typeof parsed.stmt, { kind: EKind.INSTRUCTION }>;
}

function dir(line: string) {
  const { line: parsed, errors } = parseRaw(line);

  expect(errors).toEqual([]);
  expect(parsed.stmt?.kind).toBe(EKind.DIRECTIVE);

  return parsed.stmt as Extract<typeof parsed.stmt, { kind: EKind.DIRECTIVE }>;
}

describe("RV32 parser", () => {
  describe("basic instructions", () => {
    test("parses I-type with signed immediate", () => {
      expect(parseRaw("addi sp, sp, -4").line).toMatchObject({
        line: 1,
        origin: 1,
        stmt: {
          kind: EKind.INSTRUCTION,
          mnemonic: "addi",
          operands: [
            { kind: EKind.REG, name: "sp" },
            { kind: EKind.REG, name: "sp" },
            { kind: EKind.EXPR, expr: { kind: EKind.NUM, value: -4 } },
          ],
        },
      });
    });

    test("normalizes mnemonic to lowercase", () => {
      expect(inst("ADDI SP, SP, 0").mnemonic).toBe("addi");
    });

    test("merges register and negative immediate without comma into one expression", () => {
      // "sp -4" is parsed as subtraction because '-' disambiguates the second 'sp' from REG.
      expect(inst("addi sp sp -4").operands).toEqual([
        { kind: EKind.REG, name: "sp" },
        {
          kind: EKind.EXPR,
          expr: {
            kind: EKind.BINARY,
            op: "-",
            left: { kind: EKind.SYM, name: "sp" },
            right: { kind: EKind.NUM, value: 4 },
          },
        },
      ]);
    });

    test("accepts extra comma separators", () => {
      expect(inst("addi,, sp,, sp,, -4").operands).toHaveLength(3);
    });
  });

  describe("register vs symbol disambiguation", () => {
    test("treats bare register names as REG operands", () => {
      expect(inst("addi a0, a1, a2").operands[0]).toEqual({ kind: EKind.REG, name: "a0" });
    });

    test("treats identifier followed by operator as expression symbol", () => {
      expect(parseRaw("addi zero, zero, NODE_SIZE+1").line).toMatchObject({
        stmt: {
          operands: [
            { kind: EKind.REG, name: "zero" },
            { kind: EKind.REG, name: "zero" },
            {
              kind: EKind.EXPR,
              expr: {
                kind: EKind.BINARY,
                op: "+",
                left: { kind: EKind.SYM, name: "NODE_SIZE" },
                right: { kind: EKind.NUM, value: 1 },
              },
            },
          ],
        },
      });
    });

    test("does not treat register name before memory paren as bare REG", () => {
      expect(inst("lw t0, 0(sp)").operands[1]).toEqual({
        kind: EKind.MEM,
        offset: { kind: EKind.NUM, value: 0 },
        base: "sp",
      });
    });

    test("parses .equ register alias as symbol, not REG", () => {
      expect(dir(".equ FILE_PTR s2").args).toEqual([
        { kind: EKind.SYM, name: "FILE_PTR" },
        { kind: EKind.SYM, name: "s2" },
      ]);
    });
  });

  describe("expressions", () => {
    test("parses unary minus on symbol", () => {
      expect(inst("addi sp, sp, -NODE_SIZE").operands[2]).toMatchObject({
        kind: EKind.EXPR,
        expr: { kind: EKind.UNARY, op: "-", expr: { kind: EKind.SYM, name: "NODE_SIZE" } },
      });
    });

    test("parses chained addition left-associatively", () => {
      expect(inst("addi zero, zero, 1+2+3+4").operands[2]).toMatchObject({
        expr: {
          kind: EKind.BINARY,
          op: "+",
          left: {
            kind: EKind.BINARY,
            op: "+",
            left: {
              kind: EKind.BINARY,
              op: "+",
              left: { kind: EKind.NUM, value: 1 },
              right: { kind: EKind.NUM, value: 2 },
            },
            right: { kind: EKind.NUM, value: 3 },
          },
          right: { kind: EKind.NUM, value: 4 },
        },
      });
    });

    test("gives multiplication higher precedence than addition", () => {
      expect(inst("addi zero, zero, 2*3+4").operands[2]).toMatchObject({
        expr: {
          kind: EKind.BINARY,
          op: "+",
          left: {
            kind: EKind.BINARY,
            op: "*",
            left: { kind: EKind.NUM, value: 2 },
            right: { kind: EKind.NUM, value: 3 },
          },
          right: { kind: EKind.NUM, value: 4 },
        },
      });
    });

    test("parses division and multiplication left-associatively", () => {
      expect(inst("addi zero, zero, 12/4*2").operands[2]).toMatchObject({
        expr: {
          kind: EKind.BINARY,
          op: "*",
          left: {
            kind: EKind.BINARY,
            op: "/",
            left: { kind: EKind.NUM, value: 12 },
            right: { kind: EKind.NUM, value: 4 },
          },
          right: { kind: EKind.NUM, value: 2 },
        },
      });
    });

    test("parses parenthesized sub-expressions", () => {
      expect(inst("addi zero, zero, (1+2)*3").operands[2]).toMatchObject({
        expr: {
          kind: EKind.BINARY,
          op: "*",
          left: {
            kind: EKind.BINARY,
            op: "+",
            left: { kind: EKind.NUM, value: 1 },
            right: { kind: EKind.NUM, value: 2 },
          },
          right: { kind: EKind.NUM, value: 3 },
        },
      });
    });

    test("allows whitespace around operators", () => {
      expect(inst("addi a0, a0, label + 4").operands[2]).toMatchObject({
        expr: {
          kind: EKind.BINARY,
          op: "+",
          left: { kind: EKind.SYM, name: "label" },
          right: { kind: EKind.NUM, value: 4 },
        },
      });
    });
  });

  describe("memory operands", () => {
    test("parses numeric offset", () => {
      expect(inst("lw t0, 0(t0)").operands).toEqual([
        { kind: EKind.REG, name: "t0" },
        { kind: EKind.MEM, offset: { kind: EKind.NUM, value: 0 }, base: "t0" },
      ]);
    });

    test("parses negative offset", () => {
      expect(inst("sw t0, -4(sp)").operands[1]).toMatchObject({
        kind: EKind.MEM,
        offset: { kind: EKind.NUM, value: -4 },
        base: "sp",
      });
    });

    test("parses symbolic offset expression", () => {
      expect(inst("lw t0, NODE_SIZE(t1)").operands[1]).toMatchObject({
        kind: EKind.MEM,
        offset: { kind: EKind.SYM, name: "NODE_SIZE" },
        base: "t1",
      });
    });

    test("parses relocation in offset", () => {
      expect(inst("lw a0, %hi(label)(gp)").operands[1]).toMatchObject({
        kind: EKind.MEM,
        offset: { kind: EKind.RELOC, op: "hi", arg: { kind: EKind.SYM, name: "label" } },
        base: "gp",
      });
    });
  });

  describe("relocations", () => {
    test("parses %hi/%lo symbol operands", () => {
      expect(inst("lui t0, %hi(decoded)").operands[1]).toEqual({
        kind: EKind.EXPR,
        expr: { kind: EKind.RELOC, op: "hi", arg: { kind: EKind.SYM, name: "decoded" } },
      });
    });

    test("parses pcrel relocations", () => {
      expect(inst("auipc t0, %pcrel_hi(target)").operands[1]).toMatchObject({
        expr: { kind: EKind.RELOC, op: "pcrel_hi", arg: { kind: EKind.SYM, name: "target" } },
      });
    });
  });

  describe("labels", () => {
    test("parses label-only line", () => {
      expect(parseRaw("main:").line).toEqual({ line: 1, origin: 1, label: "main", hasErrors: false });
    });

    test("parses local label reference as symbol operand", () => {
      expect(inst("j .loop").operands[0]).toEqual({
        kind: EKind.EXPR,
        expr: { kind: EKind.SYM, name: ".loop" },
      });
    });

    test("parses numeric local label declaration", () => {
      expect(parseRaw("1:").line).toEqual({ line: 1, origin: 1, label: "1", hasErrors: false });
    });

    test("parses label and instruction on the same source line", () => {
      expect(parseRaw("main: nop").line).toMatchObject({
        label: "main",
        stmt: { kind: EKind.INSTRUCTION, mnemonic: "nop", operands: [] },
      });
    });
  });

  describe("directives", () => {
    test("parses section directives without args", () => {
      expect(dir(".text")).toEqual({ kind: EKind.DIRECTIVE, name: ".text", args: [] });
      expect(dir(".rodata")).toMatchObject({ name: ".rodata", args: [] });
    });

    test("parses .equ", () => {
      expect(dir(".equ NODE_SIZE 12")).toEqual({
        kind: EKind.DIRECTIVE,
        name: ".equ",
        args: [
          { kind: EKind.SYM, name: "NODE_SIZE" },
          { kind: EKind.NUM, value: 12 },
        ],
      });
    });

    test("parses .byte with hex literals", () => {
      expect(dir(".byte 0xFF, 0x00").args).toEqual([
        { kind: EKind.NUM, value: 255 },
        { kind: EKind.NUM, value: 0 },
      ]);
    });

    test("parses string directives", () => {
      expect(dir('.string "hello"').args).toEqual([{ kind: EKind.STRING, value: "hello" }]);
    });

    test("parses .word with expression args", () => {
      expect(dir(".word NODE_SIZE+1").args[0]).toMatchObject({
        kind: EKind.BINARY,
        op: "+",
        left: { kind: EKind.SYM, name: "NODE_SIZE" },
        right: { kind: EKind.NUM, value: 1 },
      });
    });
  });

  describe("comments and blank lines", () => {
    test("ignores trailing comments", () => {
      expect(inst("addi sp, sp, -4 # grow stack").operands[2]).toMatchObject({
        expr: { kind: EKind.NUM, value: -4 },
      });
    });

    test("skips blank lines in multi-line input", () => {
      const { program, errors } = parseRawSource([".text", "", "nop"]);
      expect(errors).toEqual([]);
      expect(program.lines).toHaveLength(2);
      expect(program.lines[0].stmt).toMatchObject({ name: ".text" });
      expect(program.lines[1].stmt).toMatchObject({ mnemonic: "nop" });
    });
  });

  describe("line metadata", () => {
    test("preserves distinct parse line and source origin on tokens", () => {
      const { line } = parseRaw("nop", { number: 7, origin: 13 });
      expect(line).toMatchObject({ line: 7, origin: 13 });
    });

    test("assigns sequential parse lines across multiple physical lines", () => {
      const { program } = parseRawSource(["nop", "nop"]);
      expect(program.lines.map((l) => l.line)).toEqual([1, 2]);
      expect(program.lines.map((l) => l.origin)).toEqual([1, 2]);
    });
  });

  describe("error handling", () => {
    test("does not validate instruction arity (missing operands are accepted)", () => {
      const { program, errors } = parseRawSource(["addi sp, sp, -4", "addi sp sp", "nop"]);
      expect(errors).toEqual([]);
      expect(program.lines).toHaveLength(3);
      expect(program.lines[1].stmt).toMatchObject({
        kind: EKind.INSTRUCTION,
        mnemonic: "addi",
        operands: [
          { kind: EKind.REG, name: "sp" },
          { kind: EKind.REG, name: "sp" },
        ],
      });
    });

    test("continues parsing after a line with invalid tokens", () => {
      const { program, errors } = parseRawSource(["addi sp, sp, -4", "lw t0, @bad", "nop"]);
      expect(program.lines).toHaveLength(3);
      expect(errors.length).toBeGreaterThan(0);
      expect(program.lines[0].stmt?.kind).toBe(EKind.INSTRUCTION);
      expect(program.lines[2].stmt?.kind).toBe(EKind.INSTRUCTION);
    });

    test("reports invalid tokens", () => {
      const { errors } = parseRaw("lw t0, @bad");
      expect(errors.length).toBeGreaterThan(0);
      expect(stringifyParseError(errors[0])).toMatch(/Invalid token/);
    });

    test("treats trailing tokens as extra operands instead of rejecting them", () => {
      const { line, errors } = parseRaw("nop garbage");
      expect(errors).toEqual([]);
      expect(line.stmt).toMatchObject({
        kind: EKind.INSTRUCTION,
        mnemonic: "nop",
        operands: [{ kind: EKind.EXPR, expr: { kind: EKind.SYM, name: "garbage" } }],
      });
    });

    test("reports leftover tokens only when parsing stops before consuming them", () => {
      const { errors } = parseRaw(".equ");
      expect(errors.length).toBeGreaterThan(0);
    });

    test("reports unknown directive", () => {
      const { errors } = parseRaw(".unknown 1");
      expect(errors.length).toBeGreaterThan(0);
    });

    test("collects errors from multiple lines", () => {
      const { program, errors } = parseSource(`.text
addi sp, sp, -4
addi sp sp
lw t0, @bad
addi a0, a0, 1`);
      expect(program.lines.length).toBeGreaterThanOrEqual(4);
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(program.lines.at(-1)?.stmt?.kind).toBe(EKind.INSTRUCTION);
    });
  });
});
