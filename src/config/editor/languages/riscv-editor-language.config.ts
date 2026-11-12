import { rv_consts, rv_directives, rv_opcode, rv_opcode_pseudo, rv_reg, rv_reg_f } from "@/hardware/rv32/rv32.const";
import { rvManual } from "@/hardware/rv32/user/riscv.manual";
import type { Monaco } from "@monaco-editor/react";

let registration: { dispose(): void }[] | null = null;

import.meta.hot?.dispose(() => {
  registration?.forEach((d) => d.dispose());
  registration = null;
});

export function registerRiscvLanguage(monaco: Monaco) {
  if (registration) return;
  registration = [];

  if (!monaco.languages.getLanguages().some((l: { id: string }) => l.id === "riscv")) {
    monaco.languages.register({ id: "riscv" });
  }

  const instructions = Object.keys(rv_opcode)
    .concat(Object.keys(rv_opcode_pseudo))
    .filter((v) => !!Number.isNaN(+v));
  const directives = Object.keys(rv_directives).filter((v) => !!Number.isNaN(+v));
  const consts = Object.keys(rv_consts);
  const registers = Object.keys(rv_reg)
    .concat(Object.keys(rv_reg_f))
    .filter((v) => !!Number.isNaN(+v));

  const tokens = monaco.languages.setMonarchTokensProvider("riscv", {
    instructions: instructions.concat(instructions.map((v) => v.toUpperCase())),
    registers: registers.concat(registers.map((v) => v.toUpperCase())),
    directives: directives.concat(directives.map((v) => v.toUpperCase())),
    consts: consts,

    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [
        [/^\s*\.?[a-zA-Z0-9_]+:/, { token: "annotation" }], // label

        // eslint-disable-next-line no-useless-escape
        [/[\.%][a-zA-Z_]+/, { cases: { "@directives": "keyword" } }],

        [
          // eslint-disable-next-line no-useless-escape
          /[a-zA-Z][\.a-zA-Z0-9_]*/,
          { cases: { "@instructions": "keyword", "@registers": "type.identifier", "@consts": "identifier" } },
        ],

        [/\b0[xX][0-9a-fA-F]+\b/, "number.hex"],
        [/\b0[bB][01]+\b/, "number.binary"],
        [/\b\d+(\.\d+)?\b/, "number"],

        [/#.*$/, "comment"],

        [/'([^'\\]|\\.)'/, "string.char"],
        [/"([^"\\]|\\.)*$/, "string.invalid"], // non-teminated string
        [/'/, "string.invalid"],
        [/(')(@escapes)(')/, ["string", "string.escape", "string"]],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  });

  const configuration = monaco.languages.setLanguageConfiguration("riscv", {
    comments: {
      lineComment: "#",
    },
    brackets: [["(", ")"]],
    autoClosingPairs: [{ open: "(", close: ")" }],
    surroundingPairs: [{ open: "(", close: ")" }],
  });

  // @todo type this properly... or even better.... turn IUserManual members into dictionaries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manualEntries: any = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manualInstructionUsage: any = {};
  for (const inst of rvManual.instructions) {
    manualEntries[inst.name] = [{ value: `**${inst.operation}**` }, { value: inst.description }];
    manualInstructionUsage[inst.name] = inst.usage;
  }

  for (const reg of rvManual.registers) {
    manualEntries[reg.name] = [{ value: `**${reg.kind}** — ${reg.description}` }];

    if (reg.alias) {
      manualEntries[reg.alias] = [{ value: `**${reg.kind}** — ${reg.description}` }];
    }
  }

  for (const c of rvManual.consts) {
    manualEntries[c.name.toLowerCase()] = [{ value: c.description }];
  }

  const completion = monaco.languages.registerCompletionItemProvider("riscv", {
    triggerCharacters: [".", "%"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideCompletionItems: (model: any, position: any) => {
      const line = model.getLineContent(position.lineNumber);
      let startColumn = position.column;

      while (startColumn > 1 && /[a-zA-Z0-9_.$%]/.test(line[startColumn - 2])) {
        startColumn--;
      }

      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn,
        endColumn: position.column,
      };

      return {
        suggestions: [
          ...instructions.map((keyword) => ({
            insertText: keyword,
            label: { label: keyword, detail: " " + (manualInstructionUsage[keyword] || "") },
            kind: monaco.languages.CompletionItemKind.Keyword,
            range,
          })),
          ...consts.map((c) => ({
            insertText: c,
            label: c,
            kind: monaco.languages.CompletionItemKind.Constant,
            range,
          })),
          ...directives.map((directive) => ({
            insertText: directive,
            label: directive,
            kind: monaco.languages.CompletionItemKind.EnumMember,
            range,
          })),
          ...registers.map((register, i) => ({
            insertText: register,
            label: register,
            kind: monaco.languages.CompletionItemKind.EnumMember,
            detail: rvManual.registers?.[i]?.alias || "",
            range,
          })),
        ],
      };
    },
  });

  const hover = monaco.languages.registerHoverProvider("riscv", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideHover: (model: any, position: any) => {
      const lineContent = model.getLineContent(position.lineNumber);
      const column = position.column;

      const regex = /([a-zA-Z0-9_.]+)/g;
      let match;

      while ((match = regex.exec(lineContent)) !== null) {
        const startColumn = match.index + 1;
        const endColumn = startColumn + match[0].length;

        if (column >= startColumn && column <= endColumn) {
          const w = match[0].toLowerCase();
          const entry = manualEntries[w];

          if (entry) {
            return {
              range: new monaco.Range(position.lineNumber, startColumn, position.lineNumber, endColumn),
              contents: entry,
            };
          }
        }
      }
    },
  });

  registration.push(tokens, configuration, completion, hover);
}
