import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { IAssembledInstruction, IAssemblerResult } from "@/hardware/common/simulator";
import { EWorkerCommand, type WorkerMessageResponse } from "@/hardware/common/worker-service";
import { rv_codec } from "@/hardware/rv32/rv32.const";
import type { IDecodedRVInstruction } from "@/hardware/rv32/rv32.types";
import * as rvUtils from "@/hardware/rv32/rv32.utils";
import { useEditor } from "@/lib/contexts/editor.context";
import { useSimulator } from "@/lib/contexts/simulator.context";
import { $simulatorTab, ETabs } from "@/lib/stores/simulator-tab.store";
import { cn, fmtWordHex } from "@/lib/utils";
import { BookText } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

type IInstructionParsed = {
  instruction: IAssembledInstruction;
  stringified: string;
  code: string;
  lineNumber: number;
  manual: string;
};

function cleanLine(line: string) {
  return line.replace(/#.*$/g, "").replace(/ +/g, " ").trim();
}

const pad = (v: number | bigint, len: number) => v.toString(2).padStart(len, "0");

const Bits = memo(function MemoBits(props: { label: string; value: string; start: number; class?: string }) {
  return (
    <span className={props.class || ""} title={props.label}>
      {props.value.split("").map((bit, bitIdx) => (
        <span className={`bit-idx-${props.start + bitIdx} ${props.class || ""}`} key={bitIdx}>
          {bit}
        </span>
      ))}
    </span>
  );
});

const InstructionDecRV32 = memo(({ inst }: { inst: IDecodedRVInstruction }) => {
  const el: ReactNode[] = [];

  if (inst.codec === rv_codec.r) {
    el.push(
      <Bits label="funct7" value={pad(rvUtils.operand_funct7(inst.bytecode), 7)} start={0} class="funct7" />,
      <Bits label="rs2" value={pad(inst.rs2, 5)} start={7} class="rs2" />,
      <Bits label="rs1" value={pad(inst.rs1, 5)} start={12} class="rs1" />,
      <Bits label="funct3" value={pad(rvUtils.operand_funct3(inst.bytecode), 3)} start={17} class="funct3" />,
      <Bits label="rd" value={pad(inst.rd, 5)} start={20} class="rd" />
    );
  } else if (inst.codec === rv_codec.i) {
    el.push(
      <Bits
        label="imm[11:0]"
        value={pad(BigInt.asUintN(12, rvUtils.operand_iimm12(inst.bytecode)), 12)}
        start={0}
        class="imm"
      />,
      <Bits label="rs1" value={pad(inst.rs1, 5)} start={12} class="rs1" />,
      <Bits label="funct3" value={pad(rvUtils.operand_funct3(inst.bytecode), 3)} start={17} class="funct3" />,
      <Bits label="rd" value={pad(inst.rd, 5)} start={20} class="rd" />
    );
  } else if (inst.codec === rv_codec.s) {
    el.push(
      <Bits label="imm[11:5]" value={pad((inst.bytecode >> 25n) & 0x7fn, 7)} start={0} class="imm" />,
      <Bits label="rs2" value={pad(inst.rs2, 5)} start={7} class="rs2" />,
      <Bits label="rs1" value={pad(inst.rs1, 5)} start={12} class="rs1" />,
      <Bits label="funct3" value={pad(rvUtils.operand_funct3(inst.bytecode), 3)} start={17} class="funct3" />,
      <Bits label="imm[4:0]" value={pad((inst.bytecode >> 7n) & 0x1fn, 5)} start={20} class="imm" />
    );
  } else if (inst.codec === rv_codec.b) {
    el.push(
      <span className="imm">
        <Bits label="imm[12]" value={pad((inst.bytecode >> 31n) & 1n, 1)} start={0} class="imm" />
        <Bits label="imm[10:5]" value={pad((inst.bytecode >> 25n) & 0x3fn, 6)} start={1} class="imm" />
      </span>,
      <Bits label="rs2" value={pad(inst.rs2, 5)} start={7} class="rs2" />,
      <Bits label="rs1" value={pad(inst.rs1, 5)} start={12} class="rs1" />,
      <Bits label="funct3" value={pad(rvUtils.operand_funct3(inst.bytecode), 3)} start={17} class="funct3" />,
      <span className="imm">
        <Bits label="imm[4:1]" value={pad((inst.bytecode >> 8n) & 0xfn, 4)} start={20} class="imm" />
        <Bits label="imm[11]" value={pad((inst.bytecode >> 7n) & 1n, 1)} start={24} class="imm" />
      </span>
    );
  } else if (inst.codec === rv_codec.u) {
    el.push(
      <Bits label="imm[31:12]" value={pad(inst.bytecode >> 12n, 20)} start={0} class="imm" />,
      <Bits label="rd" value={pad(inst.rd, 5)} start={20} class="rd" />
    );
  } else if (inst.codec === rv_codec.j) {
    el.push(
      <Bits label="imm[20]" value={pad((inst.bytecode >> 31n) & 1n, 1)} start={0} class="imm" />,
      <Bits label="imm[10:1]" value={pad((inst.bytecode >> 21n) & 0x3ffn, 1)} start={1} class="imm" />,
      <Bits label="imm[11]" value={pad((inst.bytecode >> 20n) & 1n, 1)} start={11} class="imm" />,
      <Bits label="imm[19:12]" value={pad((inst.bytecode >> 12n) & 0xffn, 1)} start={12} class="imm" />,
      <Bits label="rd" value={pad(inst.rd, 5)} start={20} class="rd" />
    );
  } else if (inst.codec === rv_codec.r4) {
    el.push(
      <Bits label="rs3" value={pad(inst.rs3, 5)} start={0} class="rs3" />,
      <Bits label="fmt" value={pad(rvUtils.operand_funct7(inst.bytecode) & 0b11, 2)} start={5} class="fmt" />,
      <Bits label="rs2" value={pad(inst.rs2, 5)} start={7} class="rs2" />,
      <Bits label="rs1" value={pad(inst.rs1, 5)} start={12} class="rs1" />,
      <Bits label="rm" value={pad(rvUtils.operand_funct3(inst.bytecode), 3)} start={17} class="rm" />,
      <Bits label="rd" value={pad(inst.rd, 5)} start={20} class="rd" />
    );
  }

  return (
    <span>
      {el}
      <Bits label="opcode" value={pad(inst.opcode, 7)} start={25} class="opcode" />
    </span>
  );
});

const InstructionRow = memo(function MemoInstructionRow(props: { inst: IInstructionParsed; isCurrent: boolean }) {
  const { focusLine } = useEditor();

  return (
    <TableRow className={cn("hex-instruction-row transition-none", props.isCurrent && "hex-instruction-row--current")}>
      <TableCell>{fmtWordHex(props.inst.instruction.address)}</TableCell>
      <TableCell>
        {fmtWordHex(props.inst.instruction.decoded.bytecode)}
        <br />
        {/* {simulator.hardwareType === EHardwareType.RV32 && ( */}
        <InstructionDecRV32 inst={props.inst.instruction.decoded as IDecodedRVInstruction} />
        {/* )} */}
      </TableCell>
      <TableCell>
        {props.inst.stringified}
        <br />
        <span
          className="cursor-pointer text-xs"
          onClick={() => {
            focusLine(props.inst.lineNumber);
            $simulatorTab.set(ETabs.EDITOR);
          }}
        >
          {props.inst.lineNumber}: {props.inst.code}
        </span>
      </TableCell>
      <TableCell>
        <a
          href={props.inst.manual}
          target="_blank"
          rel="noopener noreferrer"
          // aria-label={`Open manual for ${/* props.idk @todo the name doesnt get to here */}`}
        >
          <BookText />
        </a>
      </TableCell>
    </TableRow>
  );
});

const LabelRow = memo(function MemoLabelRow(props: { label: string }) {
  return (
    <TableRow className="bg-gray-900 font-bold">
      <TableCell colSpan={4}>&lt;{props.label}&gt;:</TableCell>
    </TableRow>
  );
});

function MemoHexViewContainer(props: { program: IAssemblerResult; visible: boolean }) {
  const { simulator } = useSimulator();
  const [pc, setPc] = useState(() => simulator.processor.cpu.pc);

  const onDump = useCallback(
    (response: Extract<WorkerMessageResponse, { command: EWorkerCommand.CPU_DUMP }>) => {
      if (props.visible) {
        setPc(response.data.cpu.pc);
      }
    },
    [props.visible]
  );

  useEffect(() => {
    const ws = simulator.workerService;

    ws.on(EWorkerCommand.CPU_DUMP, onDump);
    ws.requestCpuDump();

    return () => {
      ws.off(EWorkerCommand.CPU_DUMP, onDump);
    };
  }, [simulator.workerService, onDump]);

  const labelsByAddr = useMemo(() => {
    const kv: Record<string, string[]> = {};
    for (const [lab, _addr] of Object.entries(props.program.labels)) {
      const addr = _addr.toString();

      if (Array.isArray(kv[addr])) {
        kv[addr].push(lab);
      } else {
        kv[addr] = [lab];
      }
    }

    return kv;
  }, [props.program.labels]);

  const instructions = useMemo(
    () =>
      props.program.instructions.map((inst) => {
        const stringified = simulator.processor.stringifyInstruction(inst.decoded);
        const manual = simulator.linkToManual(stringified.split(" ")[0]);

        return {
          instruction: inst,
          stringified: stringified,
          code: cleanLine(inst.code),
          lineNumber: inst.lineNumber,
          manual: manual,
        } as IInstructionParsed;
      }),
    [simulator, props.program]
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[100px]">Address</TableHead>
          <TableHead>Bytecode</TableHead>
          <TableHead>Instruction</TableHead>
          <TableHead className="w-[80px] text-center">Manual</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="font-mono">
        {instructions.map((inst, idx) => {
          const labels = labelsByAddr[inst.instruction.address.toString()];

          return (
            <Fragment key={"hex-view-row-" + idx}>
              {labels?.length && labels.map((label) => <LabelRow key={`label-${label}-${idx}`} label={label} />)}
              <InstructionRow inst={inst} isCurrent={inst.instruction.address === pc} />
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

export const HexViewContainer = memo(MemoHexViewContainer);
