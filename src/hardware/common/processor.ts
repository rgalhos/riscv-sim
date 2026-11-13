import type { IAssembledInstruction } from "./simulator";
import type { IWorkerCPUDebugDump } from "./worker-service";

type TAnyEnum = Record<string, unknown>;

export interface IDecodedInstruction {
  // Instruction bytecode
  bytecode: bigint;

  // Instruction codec
  codec: unknown;

  // Instruction opcode
  opcode: number;

  // From instruction enum
  _op: unknown;
}

export type ICPU = Record<string, unknown> & {
  register: Record<number, bigint>;
  pc: bigint;
};

export type IRegisterReadable = {
  [reg: string]: {
    regStr: string;
    value: bigint;
    str: string;
  };
};

export interface IStepUndoFrame<TDecodedInstruction> {
  pc: bigint;
  cycle: number;
  halted: boolean;
  lastExecutedInstruction: TDecodedInstruction | null;
  registers: Record<number, bigint>;
  memory: Record<number, number>;
}

export abstract class IProcessor<TDecodedInstruction extends IDecodedInstruction> {
  /**
   * List of registes used by
   * Must be a non-const TS enum
   */
  abstract readonly registers: TAnyEnum;

  /**
   * Must be a non-const TS enum
   */
  abstract readonly instructions: TAnyEnum;

  /**
   * Default memory size
   */
  public defaultMemorySize = 0xc000; // @todo - deixar coisado....

  public cycle = 0;

  public lastExecutedInstruction: TDecodedInstruction | null = null;

  public _memoryOperationDiff: Record<number, number> = {};

  public _dbgMemChanges: IWorkerCPUDebugDump["memory"] = [];
  public _dbgRegChanges: IWorkerCPUDebugDump["registers"] = [];

  public _workerBuffer: string | number = "";

  /**
   * Only refreshes screen  after an explicit update-screen syscall
   */
  public optExplicitScreenUpdate = false;

  /**
   * Simulator memory (Uint8Array view over SharedArrayBuffer when shared memory is enabled)
   */
  public memory: Uint8Array = new Uint8Array(this.defaultMemorySize);

  /**
   * Memory size
   */
  private _memorySize = this.defaultMemorySize;

  public get memorySize() {
    return this._memorySize;
  }

  public setMemorySize(size: number) {
    return (this._memorySize = size);
  }

  /**
   * Architecture base addresses
   */
  public abstract readonly baseAddresses: { [key: string]: bigint };
  // public readonly DRAM_BASE_ADDRESS: bigint = 0x00000000000n;
  // public abstract readonly PC_START: bigint;
  // public abstract readonly PROGRAM_END: bigint;
  // public abstract readonly RODATA_START: bigint;
  // public abstract readonly RODATA_END: bigint;
  // public abstract readonly DATA_START: bigint;
  // public abstract readonly DATA_END: bigint;
  // public abstract readonly BSS_START: bigint;
  // public abstract readonly BSS_END: bigint;
  // public abstract readonly FB_START: bigint;
  // public abstract readonly FB_END: bigint;
  // public abstract readonly STACK_START: bigint;
  // public abstract readonly STACK_END: bigint;

  /**
   * CPU
   */
  public abstract cpu: ICPU;

  protected instructionCache = new Map<bigint, TDecodedInstruction>();

  protected readonly undoHistoryLimit = 50;
  protected _undoStack: IStepUndoFrame<TDecodedInstruction>[] = [];
  protected _undoFrame: IStepUndoFrame<TDecodedInstruction> | null = null;

  public get canStepBack() {
    return this._undoStack.length > 0;
  }

  private _halted = true;

  /**
   * Is the CPU halted?
   */
  public get halted() {
    return this._halted;
  }

  public setHalted(halted: boolean) {
    return (this._halted = halted);
  }

  private _frequency = 1000;

  public get frequency() {
    return this._frequency;
  }

  public setFrequency(freq: number) {
    return (this._frequency = freq);
  }

  public attachMemory(view: Uint8Array) {
    this.memory = view;
  }

  /**
   * Reset CPU registers to their initial states
   */
  public resetState(options?: { clearMemory?: boolean }) {
    if (options?.clearMemory !== false && this.memory.length > 0) {
      this.memory.fill(0);
    }

    this.cycle = 0;
    this.lastExecutedInstruction = null;
    this._undoStack = [];
    this._undoFrame = null;

    this.setHalted(true);
  }
  /**
   * Function that will be used by the assembler
   * It takes a decoded instruction object and returns the instruction in bytecode
   */
  abstract toBytecode(instruction: Partial<TDecodedInstruction>): bigint;

  /**
   * Function that will be used by the disassembler
   * It takes the instruction bytecode and returns a decoded instruction object
   */
  abstract fromBytecode(instruction: bigint): TDecodedInstruction;

  /**
   * Function that will execute the instruction
   */
  abstract execute(instruction: Partial<TDecodedInstruction>): void;

  /**
   * Helper function used to stringify an instruction
   */
  abstract stringifyInstruction(instruction: Partial<TDecodedInstruction>): string;

  /**
   * Execute single instruction (step)
   */
  public abstract step(): void;

  protected registerRead(reg: number): bigint {
    if (!this.registers[reg]) {
      console.error("WIMS: Reading inexistent register: ", reg);
    }

    return this.cpu.register[reg];
  }

  protected beginUndoFrame() {
    this._undoFrame = {
      pc: this.cpu.pc,
      cycle: this.cycle,
      halted: this.halted,
      lastExecutedInstruction: this.lastExecutedInstruction,
      registers: {},
      memory: {},
    };
  }

  protected commitUndoFrame() {
    if (!this._undoFrame) return;

    this._undoStack.push(this._undoFrame);
    if (this._undoStack.length > this.undoHistoryLimit) {
      this._undoStack.shift();
    }

    this._undoFrame = null;
  }

  public stepBack(): boolean {
    const frame = this._undoStack.pop();
    if (!frame) return false;

    this.applyUndoFrame(frame);
    return true;
  }

  protected applyUndoFrame(frame: IStepUndoFrame<TDecodedInstruction>) {
    for (const reg of Object.keys(frame.registers)) {
      this.cpu.register[Number(reg)] = frame.registers[Number(reg)];
    }

    for (const addr of Object.keys(frame.memory)) {
      const value = frame.memory[Number(addr)];
      this.memory[Number(addr)] = value;
      this._memoryOperationDiff[Number(addr)] = value;
    }

    this.cpu.pc = frame.pc;
    this.cycle = frame.cycle;
    this.setHalted(frame.halted);
    this.lastExecutedInstruction = frame.lastExecutedInstruction;
  }

  protected recordRegisterUndo(reg: number, oldValue: bigint) {
    if (this._undoFrame && !(reg in this._undoFrame.registers)) {
      this._undoFrame.registers[reg] = oldValue;
    }
  }

  protected recordMemoryUndo(address: number, oldValue: number) {
    if (this._undoFrame && !(address in this._undoFrame.memory)) {
      this._undoFrame.memory[address] = oldValue;
    }
  }

  protected registerWrite(reg: number, value: bigint) {
    if (!this.registers[reg]) {
      console.error("WIMS: Writing to inexistent register: ", reg);
    }

    this.recordRegisterUndo(reg, this.cpu.register[reg]);

    this._dbgRegChanges.push({
      reg: this.registers[reg] as string,
      value: (this.cpu.register[reg] = value),
      cycle: this.cycle,
      pc: this.cpu.pc,
    });
  }

  public memoryWrite(address: bigint | number, value: bigint | number, bits: 8 | 16 | 32 = 8): void {
    const addr = Number(address);
    const v = Number(value);
    switch (bits) {
      // @ts-expect-error // eslint-disable-next-line no-fallthrough
      case 32:
        this.recordMemoryUndo(addr + 3, this.memory[addr + 3]);
        this._dbgMemChanges.push({
          address: addr + 3,
          value: (this._memoryOperationDiff[addr + 3] = this.memory[addr + 3] = (v >>> 24) & 0xff),
          cycle: this.cycle,
          pc: this.cpu.pc,
        });

        this.recordMemoryUndo(addr + 2, this.memory[addr + 2]);
        this._dbgMemChanges.push({
          address: addr + 2,
          value: (this._memoryOperationDiff[addr + 2] = this.memory[addr + 2] = (v >>> 16) & 0xff),
          cycle: this.cycle,
          pc: this.cpu.pc,
        });
      // @ts-expect-error // eslint-disable-next-line no-fallthrough
      case 16:
        this.recordMemoryUndo(addr + 1, this.memory[addr + 1]);
        this._dbgMemChanges.push({
          address: addr + 1,
          value: (this._memoryOperationDiff[addr + 1] = this.memory[addr + 1] = (v >>> 8) & 0xff),
          cycle: this.cycle,
          pc: this.cpu.pc,
        });
      // eslint-disable-next-line no-fallthrough
      default:
        this.recordMemoryUndo(addr, this.memory[addr]);
        this._dbgMemChanges.push({
          address: addr,
          value: (this._memoryOperationDiff[addr] = this.memory[addr] = v & 0xff),
          cycle: this.cycle,
          pc: this.cpu.pc,
        });
    }
  }

  public memoryRead(address: number | bigint, bits: 8 | 16 | 32 | 64 = 8): bigint {
    address = Number(address);
    // will have to change to bigint again if we implement 64 bit architectures
    const read = (addr: number) => this.memory[addr];
    let v = 0;

    switch (bits) {
      // case 64: {
      //   v |=
      //     ((read(address + 7) << 56n) & 0xffn) |
      //     ((read(address + 6) << 48n) & 0xffn) |
      //     ((read(address + 5) << 40n) & 0xffn) |
      //     ((read(address + 4) << 32n) & 0xffn);
      // }
      // @ts-expect-error // eslint-disable-next-line no-fallthrough
      case 32: {
        v |= ((read(address + 3) & 0xff) << 24) | ((read(address + 2) & 0xff) << 16);
      } // @ts-expect-error // eslint-disable-next-line no-fallthrough
      case 16: {
        v |= (read(address + 1) & 0xff) << 8;
      } // eslint-disable-next-line no-fallthrough
      default: {
        v |= read(address + 0) & 0xff;
      }
    }

    return BigInt(v);
  }

  public abstract loadProgram(program: Array<IAssembledInstruction>): void;

  public abstract getRegistersReadable(cpu: ICPU): IRegisterReadable;
}
