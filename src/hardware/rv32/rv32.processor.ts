import { IProcessor, type IRegisterReadable, type IStepUndoFrame } from "../common/processor";
import type { IAssembledInstruction } from "../common/simulator";
import {
  rv_codec,
  rv_ext,
  rv_f_rm,
  rv_opcode,
  RV_OPCODE_DATA,
  rv_reg,
  rv_reg_alias,
  rv_reg_f,
  rv_syscalls,
  rv_worker_commands,
} from "./rv32.const";
import type { IDecodedRVInstruction, IRVCPU, IRVStepUndoFrame } from "./rv32.types";
import {
  biguint32_to_f,
  encodeBType,
  encodeIType,
  encodeJType,
  encodeR4Type,
  encodeRType,
  encodeRType_RV32F,
  encodeSType,
  encodeUType,
  f_to_biguint,
  ieee754_evaluate_fma_cases,
  is_sp_inf,
  is_sp_nan,
  is_sp_neg_inf,
  is_sp_neg_norm,
  is_sp_neg_subnorm,
  is_sp_neg_zero,
  is_sp_pos_inf,
  is_sp_pos_norm,
  is_sp_pos_subnorm,
  is_sp_pos_zero,
  is_sp_signaling_nan,
  is_sp_zero,
  operand_bimm,
  operand_funct3,
  operand_funct7,
  operand_iimm12,
  operand_imm_j,
  operand_imm_u,
  operand_opcode,
  operand_rd,
  operand_rs1,
  operand_rs2,
  operand_simm12,
  rmm,
  rne,
  s32,
  SP_CANONICAL_NAN,
  SP_NEG_INF,
  SP_POS_INF,
  u32,
} from "./rv32.utils";

export class RVProcessor extends IProcessor<IDecodedRVInstruction> {
  public readonly registers = rv_reg;
  public readonly instructions = rv_opcode;
  public readonly opcodeInfo = RV_OPCODE_DATA;

  //protected readonly DRAM_BASE_ADDRESS = 0x80000000n;
  public readonly defaultMemorySize = 0xc000;

  public readonly PC_START = 0x0000n;
  public readonly PROGRAM_END = 0x2fffn;

  public readonly RODATA_START = 0x3000n;
  public readonly RODATA_END = 0x3fffn;

  public readonly DATA_START = 0x4000n;
  public readonly DATA_END = 0x4fffn;

  public readonly BSS_START = 0x5000n;
  public readonly BSS_END = 0x5fffn;

  public readonly FB_START = 0x8000n;
  public readonly FB_END = 0xa70fn;

  public readonly STACK_START = 0xc000n;
  public readonly STACK_END = 0xa710n;

  public readonly KBD_STAT = 0x6000n;
  public readonly KBD_DATA = 0x6004n;

  public readonly STDIN_STAT = 0x6010n;
  public readonly STDIN_DATA = 0x6014n;
  public readonly STDIN_SIZE = 256;

  readonly baseAddresses = {};

  public program: IAssembledInstruction[] = [];

  /**
   * Architecture config
   * @todo mainly unused in the codebase. future support for RV64
   */
  private readonly extensions = rv_ext.RV32I | rv_ext.RV32M | rv_ext.RV32F;
  public readonly ILEN = 32;
  public readonly XLEN /* : 32 | 64 */ = 32;
  public readonly FLEN /* : 32 | 64 */ = 32;
  public readonly REG_MASK = 0xffffffffn; // 2**32-1 for RV32, 2**64-1 for RV64

  private readonly initialCpuState: IRVCPU = {
    register: {
      [rv_reg.zero]: 0n,
      [rv_reg.ra]: 0n,
      [rv_reg.sp]: this.STACK_START,
      [rv_reg.gp]: 0n,
      [rv_reg.tp]: 0n,
      [rv_reg.t0]: 0n,
      [rv_reg.t1]: 0n,
      [rv_reg.t2]: 0n,
      [rv_reg.s0]: 0n,
      [rv_reg.s1]: 0n,
      [rv_reg.a0]: 0n,
      [rv_reg.a1]: 0n,
      [rv_reg.a2]: 0n,
      [rv_reg.a3]: 0n,
      [rv_reg.a4]: 0n,
      [rv_reg.a5]: 0n,
      [rv_reg.a6]: 0n,
      [rv_reg.a7]: 0n,
      [rv_reg.s2]: 0n,
      [rv_reg.s3]: 0n,
      [rv_reg.s4]: 0n,
      [rv_reg.s5]: 0n,
      [rv_reg.s6]: 0n,
      [rv_reg.s7]: 0n,
      [rv_reg.s8]: 0n,
      [rv_reg.s9]: 0n,
      [rv_reg.s10]: 0n,
      [rv_reg.s11]: 0n,
      [rv_reg.t3]: 0n,
      [rv_reg.t4]: 0n,
      [rv_reg.t5]: 0n,
      [rv_reg.t6]: 0n,
    },
    registerF: {
      [rv_reg_f.ft0]: 0n,
      [rv_reg_f.ft1]: 0n,
      [rv_reg_f.ft2]: 0n,
      [rv_reg_f.ft3]: 0n,
      [rv_reg_f.ft4]: 0n,
      [rv_reg_f.ft5]: 0n,
      [rv_reg_f.ft6]: 0n,
      [rv_reg_f.ft7]: 0n,
      [rv_reg_f.fs0]: 0n,
      [rv_reg_f.fs1]: 0n,
      [rv_reg_f.fa0]: 0n,
      [rv_reg_f.fa1]: 0n,
      [rv_reg_f.fa2]: 0n,
      [rv_reg_f.fa3]: 0n,
      [rv_reg_f.fa4]: 0n,
      [rv_reg_f.fa5]: 0n,
      [rv_reg_f.fa6]: 0n,
      [rv_reg_f.fa7]: 0n,
      [rv_reg_f.fs2]: 0n,
      [rv_reg_f.fs3]: 0n,
      [rv_reg_f.fs4]: 0n,
      [rv_reg_f.fs5]: 0n,
      [rv_reg_f.fs6]: 0n,
      [rv_reg_f.fs7]: 0n,
      [rv_reg_f.fs8]: 0n,
      [rv_reg_f.fs9]: 0n,
      [rv_reg_f.fs10]: 0n,
      [rv_reg_f.fs11]: 0n,
      [rv_reg_f.ft8]: 0n,
      [rv_reg_f.ft9]: 0n,
      [rv_reg_f.ft10]: 0n,
      [rv_reg_f.ft11]: 0n,
    },
    pc: this.PC_START,
  };

  private cloneInitialCpuState(): IRVCPU {
    return {
      ...this.initialCpuState,
      register: { ...this.initialCpuState.register },
      registerF: { ...this.initialCpuState.registerF },
    };
  }

  public cpu: IRVCPU = this.cloneInitialCpuState();

  private _pcWritten = false;

  private jumpTo(target: bigint) {
    this.cpu.pc = target;
    this._pcWritten = true;
  }

  public resetState(options?: { clearMemory?: boolean }) {
    this.cpu = this.cloneInitialCpuState();

    super.resetState(options);
  }

  public toBytecode(instruction: Partial<IDecodedRVInstruction>): bigint {
    const op = instruction._op ?? rv_opcode.illegal;
    if (!instruction || op === rv_opcode.illegal) return 0n;

    const rd = BigInt(instruction.rd ?? rv_reg.zero);
    const rs1 = BigInt(instruction.rs1 ?? rv_reg.zero);
    const rs2 = BigInt(instruction.rs2 ?? rv_reg.zero);
    let imm = instruction.imm ?? 0n;

    if (op === rv_opcode.ebreak && imm === 0n) imm = 1n;

    const codec = RV_OPCODE_DATA[op].codec;
    const ext = RV_OPCODE_DATA[op].extension;

    // if (op === rv_opcode.fence) {
    //   return u32(0b0001111n | (reg5(rd) << 7n) | (reg5(rs1) << 15n) | (pack_i_imm12(imm) << 20n));
    // }

    switch (codec) {
      case rv_codec.r:
        if (ext === rv_ext.RV32F) {
          return u32(encodeRType_RV32F(op, rd, rs1, rs2));
        }
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
      case rv_codec.r4: {
        const rs3 = BigInt(instruction.rs3 ?? rv_reg.zero);
        const rm = BigInt(instruction.rm ?? 0);
        return u32(encodeR4Type(op, rd, rs1, rs2, rs3, rm));
      }
      default:
        return 0n;
    }
  }

  public fromBytecode(instruction: bigint): IDecodedRVInstruction {
    const bytecode = u32(instruction);
    let op: rv_opcode = rv_opcode.illegal;

    switch (operand_opcode(bytecode)) {
      case 0b0110011: {
        // RV32M
        if (!!(this.extensions & rv_ext.RV32M) && operand_funct7(bytecode) === 0x1) {
          switch (operand_funct3(bytecode)) {
            case 0b000:
              op = rv_opcode.mul;
              break;
            case 0b001:
              op = rv_opcode.mulh;
              break;
            case 0b010:
              op = rv_opcode.mulhsu;
              break;
            case 0b011:
              op = rv_opcode.mulhu;
              break;
            case 0b100:
              op = rv_opcode.div;
              break;
            case 0b101:
              op = rv_opcode.divu;
              break;
            case 0b110:
              op = rv_opcode.rem;
              break;
            case 0b111:
              op = rv_opcode.remu;
              break;
          }
        } else {
          // else: RV32I
          switch (operand_funct3(bytecode)) {
            case 0x0:
              switch (operand_funct7(bytecode)) {
                case 0x00:
                  op = rv_opcode.add;
                  break;
                case 0x20:
                  op = rv_opcode.sub;
                  break;
              }
              break;
            case 0x1:
              op = rv_opcode.sll;
              break;
            case 0x2:
              op = rv_opcode.slt;
              break;
            case 0x3:
              op = rv_opcode.sltu;
              break;
            case 0x4:
              op = rv_opcode.xor;
              break;
            case 0x5:
              switch (operand_funct7(bytecode)) {
                case 0x00:
                  op = rv_opcode.srl;
                  break;
                case 0x20:
                  op = rv_opcode.sra;
                  break;
              }
              break;
            case 0x6:
              op = rv_opcode.or;
              break;
            case 0x7:
              op = rv_opcode.and;
              break;
          }
        }
        break;
      }
      case 0b0010011: {
        switch (operand_funct3(bytecode)) {
          case 0x0:
            op = rv_opcode.addi;
            break;
          case 0x1:
            op = rv_opcode.slli;
            break;
          case 0x2:
            op = rv_opcode.slti;
            break;
          case 0x3:
            op = rv_opcode.sltiu;
            break;
          case 0x4:
            op = rv_opcode.xori;
            break;
          case 0x5:
            switch (operand_funct7(bytecode)) {
              case 0x00:
                op = rv_opcode.srli;
                break;
              case 0x20:
                op = rv_opcode.srai;
                break;
            }
            break;
          case 0x6:
            op = rv_opcode.ori;
            break;
          case 0x7:
            op = rv_opcode.andi;
            break;
        }
        break;
      }
      case 0b0000011: {
        switch (operand_funct3(bytecode)) {
          case 0x0:
            op = rv_opcode.lb;
            break;
          case 0x1:
            op = rv_opcode.lh;
            break;
          case 0x2:
            op = rv_opcode.lw;
            break;
          case 0x4:
            op = rv_opcode.lbu;
            break;
          case 0x5:
            op = rv_opcode.lhu;
            break;
        }
        break;
      }
      case 0b0100011: {
        switch (operand_funct3(bytecode)) {
          case 0x0:
            op = rv_opcode.sb;
            break;
          case 0x1:
            op = rv_opcode.sh;
            break;
          case 0x2:
            op = rv_opcode.sw;
            break;
        }
        break;
      }
      case 0b1100011: {
        switch (operand_funct3(bytecode)) {
          case 0x0:
            op = rv_opcode.beq;
            break;
          case 0x1:
            op = rv_opcode.bne;
            break;
          case 0x4:
            op = rv_opcode.blt;
            break;
          case 0x5:
            op = rv_opcode.bge;
            break;
          case 0x6:
            op = rv_opcode.bltu;
            break;
          case 0x7:
            op = rv_opcode.bgeu;
            break;
        }
        break;
      }
      case 0b1101111:
        op = rv_opcode.jal;
        break;
      case 0b1100111:
        op = rv_opcode.jalr;
        break;
      case 0b0110111:
        op = rv_opcode.lui;
        break;
      case 0b0010111:
        op = rv_opcode.auipc;
        break;
      case 0b1110011: {
        if (operand_funct3(bytecode) !== 0) break;
        const sysImm = Number((u32(bytecode) >> 20n) & 0xfffn);
        if (sysImm === 0) op = rv_opcode.ecall;
        else if (sysImm === 1) op = rv_opcode.ebreak;
        break;
      }

      // RV32F
      case 0b0000111:
        op = rv_opcode.flw;
        break;
      case 0b0100111:
        op = rv_opcode.fsw;
        break;
      case 0b1000011:
        op = rv_opcode["fmadd.s"];
        break;
      case 0b1000111:
        op = rv_opcode["fmsub.s"];
        break;
      case 0b1001011:
        op = rv_opcode["fnmsub.s"];
        break;
      case 0b1001111:
        op = rv_opcode["fnmadd.s"];
        break;
      case 0b1010011: {
        const funct5 = operand_funct7(bytecode) >> 2;

        switch (operand_funct3(bytecode)) {
          case 0b000: {
            switch (funct5) {
              case 0b00000:
                op = rv_opcode["fadd.s"];
                break;
              case 0b00001:
                op = rv_opcode["fsub.s"];
                break;
              case 0b00010:
                op = rv_opcode["fmul.s"];
                break;
              case 0b00011:
                op = rv_opcode["fdiv.s"];
                break;
              case 0b01011:
                op = rv_opcode["fsqrt.s"];
                break;
              case 0b00100:
                op = rv_opcode["fsgnj.s"];
                break;
              case 0b00101:
                op = rv_opcode["fmin.s"];
                break;
              case 0b11000:
                if (bytecode & (1n << 20n)) {
                  op = rv_opcode["fcvt.wu.s"];
                } else {
                  op = rv_opcode["fcvt.w.s"];
                }
                break;
              case 0b11100:
                op = rv_opcode["fmv.x.w"];
                break;
              case 0b11110:
                op = rv_opcode["fmv.w.x"];
                break;
              case 0b10100:
                op = rv_opcode["fle.s"];
                break;
              case 0b11010: {
                // edge case: bit 20 is set for fcvt.s.wu
                if (bytecode & (1n << 20n)) {
                  op = rv_opcode["fcvt.s.wu"];
                } else {
                  op = rv_opcode["fcvt.s.w"];
                }
                break;
              }
            }
            break;
          }
          case 0b001: {
            switch (funct5) {
              case 0b00100:
                op = rv_opcode["fsgnjn.s"];
                break;
              case 0b00101:
                op = rv_opcode["fmax.s"];
                break;
              case 0b10100:
                op = rv_opcode["flt.s"];
                break;
              case 0b11100:
                op = rv_opcode["fclass.s"];
                break;
            }
            break;
          }
          case 0b010: {
            switch (funct5) {
              case 0b00100:
                op = rv_opcode["fsgnjx.s"];
                break;
              case 0b10100:
                op = rv_opcode["feq.s"];
                break;
            }
            break;
          }
        }
      }
    }

    if (op === rv_opcode.illegal) {
      return {
        bytecode,
        _op: rv_opcode.illegal,
        opcode: 0,
        codec: rv_codec.illegal,
        rd: rv_reg.zero,
        rs1: rv_reg.zero,
        rs2: rv_reg.zero,
        rs3: rv_reg.zero,
        imm: 0n,
        rm: 0,
      };
    }

    const op_info = RV_OPCODE_DATA[op];
    const dec: IDecodedRVInstruction = {
      bytecode,
      _op: op,
      opcode: op_info.opcode,
      codec: op_info.codec,
      rd: rv_reg.zero,
      rs1: rv_reg.zero,
      rs2: rv_reg.zero,
      rs3: rv_reg.zero,
      imm: 0n,
      rm: 0,
    };

    switch (op_info.codec) {
      case rv_codec.r:
        dec.rd = operand_rd(bytecode);
        dec.rs1 = operand_rs1(bytecode);
        dec.rs2 = operand_rs2(bytecode);
        break;
      case rv_codec.i:
        dec.rd = operand_rd(bytecode);
        dec.rs1 = operand_rs1(bytecode);
        dec.imm = operand_iimm12(bytecode);
        break;
      case rv_codec.s:
        dec.rs1 = operand_rs1(bytecode);
        dec.rs2 = operand_rs2(bytecode);
        dec.imm = operand_simm12(bytecode);
        break;
      case rv_codec.b:
        dec.rs1 = operand_rs1(bytecode);
        dec.rs2 = operand_rs2(bytecode);
        dec.imm = operand_bimm(bytecode);
        break;
      case rv_codec.u:
        dec.rd = operand_rd(bytecode);
        dec.imm = operand_imm_u(bytecode);
        break;
      case rv_codec.j:
        dec.rd = operand_rd(bytecode);
        dec.imm = operand_imm_j(bytecode);
        break;
      case rv_codec.r4:
        dec.rd = operand_rd(bytecode);
        dec.rs1 = operand_rs1(bytecode);
        dec.rs2 = operand_rs2(bytecode);
        dec.rs3 = operand_funct7(bytecode) >> 2;
        // dec.fmt = operand_funct7(bytecode) & 0b11;
        dec.rm = operand_funct3(bytecode);
        break;
      default:
        dec.imm = 0n;
        break;
    }

    return dec;
  }

  public fetch() {
    if (this.cpu.pc - 4n >= this.memory.length) {
      return 0xf00fffffn;
    }

    return this.memoryRead(this.cpu.pc, 32);
  }

  public decode(inst: bigint) {
    const cached = this.instructionCache.get(inst);

    if (cached) {
      return cached;
    }

    const dec = this.fromBytecode(inst);

    if (dec.codec !== rv_codec.illegal) {
      this.instructionCache.set(inst, dec);
    }

    return dec;
  }

  public execute(d: IDecodedRVInstruction): rv_worker_commands | void {
    this.lastExecutedInstruction = d;
    this.cycle++;

    const pc = this.cpu.pc;
    const v1 = this.registerRead(d.rs1);
    const v2 = this.registerRead(d.rs2);

    switch (d._op) {
      // RV32I
      case rv_opcode.lui:
        this.registerWrite(d.rd, u32(d.imm << 12n));
        return;
      case rv_opcode.auipc:
        this.registerWrite(d.rd, u32(pc + u32(d.imm << 12n)));
        return;
      case rv_opcode.jal:
        this.registerWrite(d.rd, pc + 4n);
        this.jumpTo(u32(pc + d.imm));
        return;
      case rv_opcode.jalr: {
        const t = u32(v1 + d.imm) & ~1n;
        this.registerWrite(d.rd, pc + 4n);
        this.jumpTo(t);
        return;
      }
      case rv_opcode.beq:
        if (v1 === v2) this.jumpTo(u32(pc + d.imm));
        return;
      case rv_opcode.bne:
        if (v1 !== v2) this.jumpTo(u32(pc + d.imm));
        return;
      case rv_opcode.blt:
        if (s32(v1) < s32(v2)) this.jumpTo(u32(pc + d.imm));
        return;
      case rv_opcode.bge:
        if (s32(v1) >= s32(v2)) this.jumpTo(u32(pc + d.imm));
        return;
      case rv_opcode.bltu:
        if (u32(v1) < u32(v2)) this.jumpTo(u32(pc + d.imm));
        return;
      case rv_opcode.bgeu:
        if (u32(v1) >= u32(v2)) this.jumpTo(u32(pc + d.imm));
        return;
      case rv_opcode.lb: {
        const addr = u32(v1 + d.imm);
        let b = this.memoryRead(addr, 8) & 0xffn;
        if (b & 0x80n) b |= ~0xffn;
        this.registerWrite(d.rd, u32(b));
        return;
      }
      case rv_opcode.lh: {
        const addr = u32(v1 + d.imm);
        let h = this.memoryRead(addr, 16) & 0xffffn;
        if (h & 0x8000n) h |= ~0xffffn;
        this.registerWrite(d.rd, u32(h));
        return;
      }
      case rv_opcode.lw: {
        const addr = u32(v1 + d.imm);
        this.registerWrite(d.rd, u32(this.memoryRead(addr, 32)));
        return;
      }
      case rv_opcode.lbu: {
        const addr = u32(v1 + d.imm);
        this.registerWrite(d.rd, this.memoryRead(addr, 8) & 0xffn);
        return;
      }
      case rv_opcode.lhu: {
        const addr = u32(v1 + d.imm);
        this.registerWrite(d.rd, this.memoryRead(addr, 16) & 0xffffn);
        return;
      }
      case rv_opcode.sb:
        this.memoryWrite(u32(v1 + d.imm), v2 & 0xffn, 8);
        return;
      case rv_opcode.sh:
        this.memoryWrite(u32(v1 + d.imm), v2 & 0xffffn, 16);
        return;
      case rv_opcode.sw:
        this.memoryWrite(u32(v1 + d.imm), v2, 32);
        return;
      case rv_opcode.addi:
        this.registerWrite(d.rd, u32(v1 + d.imm));
        return;
      case rv_opcode.slti:
        this.registerWrite(d.rd, s32(v1) < s32(d.imm) ? 1n : 0n);
        return;
      case rv_opcode.sltiu:
        this.registerWrite(d.rd, u32(v1) < u32(d.imm) ? 1n : 0n);
        return;
      case rv_opcode.xori:
        this.registerWrite(d.rd, u32(v1 ^ d.imm));
        return;
      case rv_opcode.ori:
        this.registerWrite(d.rd, u32(v1 | d.imm));
        return;
      case rv_opcode.andi:
        this.registerWrite(d.rd, u32(v1 & d.imm));
        return;
      case rv_opcode.slli:
        this.registerWrite(d.rd, u32(u32(v1) << (d.imm & 0x1fn)));
        return;
      case rv_opcode.srli:
        this.registerWrite(d.rd, u32(v1) >> (d.imm & 0x1fn));
        return;
      case rv_opcode.srai:
        this.registerWrite(d.rd, u32(s32(v1) >> (d.imm & 0x1fn)));
        return;
      case rv_opcode.add:
        this.registerWrite(d.rd, u32(v1 + v2));
        return;
      case rv_opcode.sub:
        this.registerWrite(d.rd, u32(v1 - v2));
        return;
      case rv_opcode.sll:
        this.registerWrite(d.rd, u32(u32(v1) << (v2 & 0x1fn)));
        return;
      case rv_opcode.slt:
        this.registerWrite(d.rd, s32(v1) < s32(v2) ? 1n : 0n);
        return;
      case rv_opcode.sltu:
        this.registerWrite(d.rd, u32(v1) < u32(v2) ? 1n : 0n);
        return;
      case rv_opcode.xor:
        this.registerWrite(d.rd, u32(v1 ^ v2));
        return;
      case rv_opcode.srl:
        this.registerWrite(d.rd, u32(u32(v1) >> (v2 & 0x1fn)));
        return;
      case rv_opcode.sra:
        this.registerWrite(d.rd, u32(s32(v1) >> (v2 & 0x1fn)));
        return;
      case rv_opcode.or:
        this.registerWrite(d.rd, u32(v1 | v2));
        return;
      case rv_opcode.and:
        this.registerWrite(d.rd, u32(v1 & v2));
        return;
      case rv_opcode.ecall: {
        const syscall = Number(this.registerRead(rv_reg.a7));
        let ret = rv_worker_commands.NONE;

        if (syscall === rv_syscalls.syscall_fill_screen) {
          const a0 = Number(this.registerRead(rv_reg.a0));
          this.memory.fill(a0, Number(this.FB_START), Number(this.FB_END));

          ret = rv_worker_commands.SYNC_LISTENERS;
        } else if (syscall === rv_syscalls.syscall_update_screen) {
          ret = rv_worker_commands.UPDATE_FRAMEBUFFER;
        } else if (syscall === rv_syscalls.syscall_print_string) {
          const a0 = Number(this.registerRead(rv_reg.a0));
          // meio paia mas é oq tem pra janta
          const memory = this.memory.subarray(a0, a0 + 255);

          let nulIdx = memory.findIndex((v) => v === 0);
          nulIdx = nulIdx === -1 ? 255 : nulIdx;

          const str = String.fromCharCode(...memory.slice(0, nulIdx));
          this._workerBuffer = str;

          ret = rv_worker_commands.PRINT_STRING;
        } else if (syscall === rv_syscalls.syscall_printf) {
          const a0 = Number(this.registerRead(rv_reg.a0));
          // meio paia mas é oq tem pra janta
          const memory = this.memory.subarray(a0, a0 + 255);

          let nulIdx = memory.findIndex((v) => v === 0);
          nulIdx = nulIdx === -1 ? 255 : nulIdx;

          let i = 0;
          const str = String.fromCharCode(...memory.slice(0, nulIdx)).replace(/%d|%u|%x|%X|%c|%p|%f|%%/g, (match) => {
            if (match === "%%") return "%";
            i++;
            switch (match) {
              case "%d":
                return BigInt.asIntN(32, this.registerRead(rv_reg.a0 + i)).toString();
              case "%u":
                return this.registerRead(rv_reg.a0 + i).toString();
              case "%x":
                return this.registerRead(rv_reg.a0 + i).toString(16);
              case "%X":
                return this.registerRead(rv_reg.a0 + i)
                  .toString(16)
                  .toUpperCase();
              case "%c":
                return String.fromCharCode(Number(this.registerRead(rv_reg.a0 + i)) || 0);
              case "%p":
                return (
                  "0x" +
                  this.registerRead(rv_reg.a0 + i)
                    .toString(16)
                    .toUpperCase()
                    .padStart(8, "0")
                );
              case "%f":
                return biguint32_to_f(this.registerRead(rv_reg.a0 + i)).toString();
            }

            return match;
          });

          this._workerBuffer = str;
          ret = rv_worker_commands.PRINT_STRING;
        } else if (syscall === rv_syscalls.syscall_print_uint) {
          const a0 = BigInt.asUintN(32, this.registerRead(rv_reg.a0));
          this._workerBuffer = a0 + "\n";

          ret = rv_worker_commands.PRINT_STRING;
        } else if (syscall === rv_syscalls.syscall_print_int) {
          const a0 = BigInt.asIntN(32, this.registerRead(rv_reg.a0));
          this._workerBuffer = a0 + "\n";

          ret = rv_worker_commands.PRINT_STRING;
        } else if (syscall === rv_syscalls.syscall_print_float) {
          const a0 = this.registerRead(rv_reg.a0);
          this._workerBuffer = biguint32_to_f(a0).toString() + "\n";

          ret = rv_worker_commands.PRINT_STRING;
        } else if (syscall === rv_syscalls.syscall_read_int) {
          const stdinData = Number(this.STDIN_DATA);
          const len = Math.min(255, Number(this.memoryRead(this.STDIN_STAT, 32)));
          const memval = this.memory.slice(stdinData, stdinData + len);
          const num = Number.parseInt(String.fromCharCode(...memval), 10);

          if (!Number.isNaN(num)) {
            this.registerWrite(rv_reg.a0, u32(BigInt(num)));
          } else {
            this.registerWrite(rv_reg.a0, this.memoryRead(this.STDIN_DATA, 32));
          }

          this.memoryWrite(this.STDIN_STAT, 0, 32);
        } else if (syscall === rv_syscalls.syscall_read_string) {
          const addr = Number(this.registerRead(rv_reg.a0));
          const len = Math.min(255, Number(this.memoryRead(this.STDIN_STAT, 32)));
          const str = this.memory.slice(Number(this.STDIN_DATA), Number(this.STDIN_DATA) + len);

          for (let i = 0; i < str.length; i++) {
            this.memoryWrite(addr + i, str[i], 8);
          }

          this.memoryWrite(this.STDIN_STAT, 0, 32);
        } else if (syscall === rv_syscalls.syscall_read_char) {
          this.registerWrite(rv_reg.a0, this.memoryRead(this.STDIN_DATA, 8));

          this.memoryWrite(this.STDIN_STAT, 0, 32);
        } else if (syscall === rv_syscalls.syscall_read_float) {
          const len = Math.min(255, Number(this.memoryRead(this.STDIN_STAT, 32)));
          const memval = this.memory.slice(Number(this.STDIN_DATA), Number(this.STDIN_DATA) + len);
          const num = Math.fround(Number.parseFloat(String.fromCharCode(...memval)));

          if (!Number.isNaN(num)) {
            this.registerWrite(rv_reg.a0, f_to_biguint(num));
          } else {
            this.registerWrite(rv_reg.a0, this.memoryRead(this.STDIN_DATA, 32));
          }

          this.memoryWrite(this.STDIN_STAT, 0, 32);
        } else if (syscall === rv_syscalls.syscall_random_bytes) {
          const addr = this.registerRead(rv_reg.a0);
          const bytes = Math.min(4, Number(this.registerRead(rv_reg.a1))) || 4;
          const rand = BigInt(Math.round(Math.random() * 0xffffffff));

          switch (bytes) {
            // @ts-expect-error // eslint-disable-next-line no-fallthrough
            case 4:
              this.memoryWrite(addr + 3n, (rand >> 24n) & 0xffn, 8);
            // @ts-expect-error // eslint-disable-next-line no-fallthrough
            case 3:
              this.memoryWrite(addr + 2n, (rand >> 16n) & 0xffn, 8);
            // @ts-expect-error // eslint-disable-next-line no-fallthrough
            case 2:
              this.memoryWrite(addr + 1n, (rand >> 8n) & 0xffn, 8);
            // eslint-disable-next-line no-fallthrough
            default:
              this.memoryWrite(addr + 0n, rand & 0xffn, 8);
          }
        }

        return ret;
      }
      case rv_opcode.ebreak:
        this.setHalted(true);
        return;

      // RV32M
      case rv_opcode.mul:
        this.registerWrite(d.rd, v1 * v2);
        return;
      case rv_opcode.mulh:
        this.registerWrite(d.rd, (BigInt.asIntN(32, v1) * BigInt.asIntN(32, v2)) >> 32n);
        return;
      case rv_opcode.mulhsu:
        this.registerWrite(d.rd, (BigInt.asIntN(32, v1) * v2) >> 32n);
        return;
      case rv_opcode.mulhu:
        this.registerWrite(d.rd, (v1 * v2) >> 32n);
        return;
      case rv_opcode.div: {
        let xd;
        if (v2 === 0n) {
          xd = BigInt.asUintN(32, -1n);
        } else {
          xd = s32(v1) / s32(v2);
        }
        this.registerWrite(d.rd, xd);
        return;
      }
      case rv_opcode.divu: {
        let xd;
        if (v2 === 0n) {
          xd = 0xffffffffn;
        } else {
          xd = BigInt(v1 / v2);
        }
        this.registerWrite(d.rd, xd);
        return;
      }
      case rv_opcode.rem: {
        let xd;
        if (v2 === 0n) {
          xd = v1;
        } else {
          xd = s32(v1) % s32(v2);
        }
        this.registerWrite(d.rd, xd);
        return;
      }
      case rv_opcode.remu: {
        let xd;
        if (v2 === 0n) {
          xd = v1;
        } else {
          xd = v1 % v2;
        }
        this.registerWrite(d.rd, xd);
        return;
      }
    }

    if (d._op !== rv_opcode.illegal && !(this.extensions & rv_ext.RV32F)) {
      return;
    }

    const vf1 = this.registerReadFloat32(d.rs1);
    const vf2 = this.registerReadFloat32(d.rs2);
    const vf3 = this.registerReadFloat32(d.rs3);

    // RV32F
    switch (d._op) {
      case rv_opcode.flw:
        const addr = u32(v1 + d.imm);
        this.registerWriteF(d.rd, u32(this.memoryRead(addr, 32)));
        return;
      case rv_opcode.fsw:
        this.memoryWrite(u32(v1 + d.imm), vf2, 32);
        return;
      case rv_opcode["fmadd.s"]: {
        // @todo rounding mode
        const ev = ieee754_evaluate_fma_cases(vf1, vf2, vf3, false, false);
        if (ev !== null) {
          return this.registerWriteF(d.rd, ev);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        const c = biguint32_to_f(vf3);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(a * b + c)));
        return;
      }
      case rv_opcode["fmsub.s"]: {
        // @todo rounding mode
        const ev = ieee754_evaluate_fma_cases(vf1, vf2, vf3, false, true);
        if (ev !== null) {
          return this.registerWriteF(d.rd, ev);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        const c = biguint32_to_f(vf3);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(a * b - c)));
        return;
      }
      case rv_opcode["fnmsub.s"]: {
        // @todo rounding mode
        const ev = ieee754_evaluate_fma_cases(vf1, vf2, vf3, true, false);
        if (ev !== null) {
          return this.registerWriteF(d.rd, ev);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        const c = biguint32_to_f(vf3);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(-(a * b) + c)));
        return;
      }
      case rv_opcode["fnmadd.s"]: {
        // @todo rounding mode
        const ev = ieee754_evaluate_fma_cases(vf1, vf2, vf3, true, true);
        if (ev !== null) {
          return this.registerWriteF(d.rd, ev);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        const c = biguint32_to_f(vf3);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(-(a * b) - c)));
        return;
      }
      case rv_opcode["fadd.s"]: {
        // @todo rounding mode
        if (is_sp_nan(vf1) || is_sp_nan(vf2)) {
          // @todo check signaling NaN and set NV bit
          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        } else if (is_sp_inf(vf1) && is_sp_inf(vf2)) {
          // different signals = NaN
          return this.registerWriteF(d.rd, vf1 !== vf2 ? SP_CANONICAL_NAN : vf1);
        } else if (is_sp_inf(vf1)) {
          return this.registerWriteF(d.rd, vf1);
        } else if (is_sp_inf(vf2)) {
          return this.registerWriteF(d.rd, vf2);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(a + b)));
        return;
      }
      case rv_opcode["fsub.s"]: {
        // @todo rounding mode
        if (is_sp_nan(vf1) || is_sp_nan(vf2)) {
          // @todo check signaling NaN and set NV bit
          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        } else if (is_sp_inf(vf1) && is_sp_inf(vf2)) {
          // in subtraction, same signal = NaN
          return this.registerWriteF(d.rd, vf1 === vf2 ? SP_CANONICAL_NAN : vf1);
        } else if (is_sp_inf(vf1)) {
          return this.registerWriteF(d.rd, vf1);
        } else if (is_sp_inf(vf2)) {
          return this.registerWriteF(d.rd, vf2 ^ 0x80000000n);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(a - b)));
        return;
      }
      case rv_opcode["fmul.s"]: {
        // @todo rounding mode
        if (is_sp_nan(vf1) || is_sp_nan(vf2)) {
          // @todo check signaling NaN and set NV bit
          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        } else if (is_sp_inf(vf1) && is_sp_inf(vf2)) {
          // different signal = pos infinity
          return this.registerWriteF(d.rd, vf1 === vf2 ? SP_POS_INF : SP_NEG_INF);
        } else if (is_sp_inf(vf1) || is_sp_inf(vf2)) {
          const zero = is_sp_zero(vf1) || is_sp_zero(vf2);
          if (zero) return this.registerWriteF(d.rd, SP_CANONICAL_NAN);

          const signal = ((vf1 >> 31n) ^ (vf2 >> 31n)) & 1n;
          return this.registerWriteF(d.rd, signal ? SP_NEG_INF : SP_POS_INF);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(a * b)));
        return;
      }
      case rv_opcode["fdiv.s"]: {
        // @todo rounding mode
        // @todo set DZ flag
        if (
          is_sp_nan(vf1) ||
          is_sp_nan(vf2) ||
          (is_sp_zero(vf1) && is_sp_zero(vf2)) ||
          (is_sp_inf(vf1) && is_sp_inf(vf2))
        ) {
          // 0 / 0 = NaN
          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        } else if (is_sp_zero(vf2)) {
          const signal = ((vf1 >> 31n) ^ (vf2 >> 31n)) & 1n;
          return this.registerWriteF(d.rd, signal ? SP_NEG_INF : SP_POS_INF);
        } else if (is_sp_inf(vf1)) {
          // INF/x = INF for x > 0, -INF for x < 0
          return this.registerWriteF(d.rd, vf2 >> 31n ? SP_NEG_INF : SP_POS_INF);
        }

        {
          const a = biguint32_to_f(vf1);
          const b = biguint32_to_f(vf2);
          this.registerWriteF(d.rd, f_to_biguint(Math.fround(a / b)));
        }
        return;
      }
      case rv_opcode["fsqrt.s"]: {
        // @todo rounding mode
        if (is_sp_nan(vf1) || is_sp_neg_inf(vf1)) {
          // @todo handle signaling NaN and set NV bit
          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        } else if (is_sp_pos_inf(vf1)) {
          return this.registerWriteF(d.rd, SP_POS_INF);
        } else if ((vf1 >> 31n) & 1n) {
          if (is_sp_neg_zero(vf1)) {
            return this.registerWriteF(d.rd, vf1);
          }

          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        }

        const a = biguint32_to_f(vf1);
        this.registerWriteF(d.rd, f_to_biguint(Math.fround(Math.sqrt(a))));
        return;
      }
      case rv_opcode["fsgnj.s"]: {
        this.registerWriteF(d.rd, (vf1 & 0x7fffffffn) | (vf2 & 0x80000000n));
        return;
      }
      case rv_opcode["fsgnjn.s"]: {
        this.registerWriteF(d.rd, (vf1 & 0x7fffffffn) | (~vf2 & 0x80000000n));
        return;
      }
      case rv_opcode["fsgnjx.s"]: {
        this.registerWriteF(d.rd, vf1 ^ (vf2 & 0x80000000n));
        return;
      }
      case rv_opcode["fmin.s"]: {
        // both NaN = NaN
        if (is_sp_nan(vf1) && is_sp_nan(vf2)) {
          // @todo handle signaling NaN
          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        }
        // if one operand is NaN = the other operand
        else if (is_sp_nan(vf1)) {
          return this.registerWriteF(d.rd, vf2);
        } else if (is_sp_nan(vf2)) {
          return this.registerWriteF(d.rd, vf1);
        }
        // -0.0 is lower than +0.0
        else if (is_sp_zero(vf1) && is_sp_zero(vf2)) {
          return this.registerWriteF(d.rd, is_sp_neg_zero(vf1) ? vf1 : vf2);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        this.registerWriteF(d.rd, a > b ? vf2 : vf1);
        return;
      }
      case rv_opcode["fmax.s"]: {
        // both NaN = NaN
        if (is_sp_nan(vf1) && is_sp_nan(vf2)) {
          // @todo handle signaling NaN
          return this.registerWriteF(d.rd, SP_CANONICAL_NAN);
        }
        // if one operand is NaN = the other operand
        else if (is_sp_nan(vf1)) {
          return this.registerWriteF(d.rd, vf2);
        } else if (is_sp_nan(vf2)) {
          return this.registerWriteF(d.rd, vf1);
        }
        // -0.0 is lower than +0.0
        else if (is_sp_zero(vf1) && is_sp_zero(vf2)) {
          return this.registerWriteF(d.rd, is_sp_neg_zero(vf1) ? vf2 : vf1);
        }

        const a = biguint32_to_f(vf1);
        const b = biguint32_to_f(vf2);
        this.registerWriteF(d.rd, a > b ? vf1 : vf2);
        return;
      }
      case rv_opcode["fcvt.w.s"]: {
        // @todo implement rounding mode... correctly
        // @todo set inexact and invalid flag
        if (is_sp_neg_inf(vf1)) {
          return this.registerWrite(d.rd, 0x80000000n);
        } else if (is_sp_pos_inf(vf1) || is_sp_nan(vf1)) {
          return this.registerWrite(d.rd, 0x7fffffffn);
        }

        const a = biguint32_to_f(vf1);
        let v = 0;

        if (d.rm === rv_f_rm.RNE) v = rne(a);
        else if (d.rm === rv_f_rm.RTZ) v = Math.trunc(a);
        else if (d.rm === rv_f_rm.RDN) v = Math.floor(a);
        else if (d.rm === rv_f_rm.RUP) v = Math.ceil(a);
        else if (d.rm === rv_f_rm.RMM) v = rmm(a);
        else v = Math.trunc(a);

        if (v > 2147483647) {
          return this.registerWrite(d.rd, 0x7fffffffn);
        } else if (v < -2147483648) {
          return this.registerWrite(d.rd, 0x80000000n);
        }

        this.registerWrite(d.rd, BigInt(v));
        return;
      }
      case rv_opcode["fcvt.wu.s"]: {
        // @todo implement rounding mode... correctly
        // @todo set inexact and invalid flag
        if (is_sp_neg_inf(vf1)) {
          return this.registerWrite(d.rd, 0n);
        } else if (is_sp_pos_inf(vf1) || is_sp_nan(vf1)) {
          return this.registerWrite(d.rd, 0xffffffffn);
        }

        const a = biguint32_to_f(vf1);
        let v = 0;

        if (d.rm === rv_f_rm.RNE) v = rne(a);
        else if (d.rm === rv_f_rm.RTZ) v = Math.trunc(a);
        else if (d.rm === rv_f_rm.RDN) v = Math.floor(a);
        else if (d.rm === rv_f_rm.RUP) v = Math.ceil(a);
        else if (d.rm === rv_f_rm.RMM) v = rmm(a);
        else v = Math.trunc(a);

        if (v > 4294967295) {
          return this.registerWrite(d.rd, 0xffffffffn);
        } else if (v < 0) {
          return this.registerWrite(d.rd, 0n);
        }

        this.registerWrite(d.rd, BigInt(v));
        return;
      }
      case rv_opcode["fmv.x.w"]:
        this.registerWrite(d.rd, vf1);
        return;
      case rv_opcode["feq.s"]:
        if (is_sp_nan(vf1) || is_sp_nan(vf2)) {
          // @todo: handle signaling NaN
          this.registerWrite(d.rd, 0n);
        } else {
          const eq = vf1 === vf2 || ((vf1 & 0x7fffffffn) === 0n && (vf2 & 0x7fffffffn) === 0n);
          this.registerWrite(d.rd, eq ? 1n : 0n);
        }
        return;
      case rv_opcode["flt.s"]:
        // @todo handle INF
        if (is_sp_nan(vf1) || is_sp_nan(vf2)) {
          // @todo: set invalid
          this.registerWrite(d.rd, 0n);
        } else {
          const signA = vf1 >> 31n;
          const signB = vf2 >> 31n;
          const magA = vf1 & 0x7fffffffn;
          const magB = vf2 & 0x7fffffffn;
          let lt = false;

          if (signA !== signB) {
            lt = !!signA && !(magA === 0n && magB === 0n);
          } else if (vf1 === vf2) {
            lt = false;
          } else if (signA === 0n) {
            lt = vf1 < vf2;
          } else {
            lt = vf1 > vf2;
          }

          this.registerWrite(d.rd, lt ? 1n : 0n);
        }
        return;
      case rv_opcode["fle.s"]:
        // @todo handle INF
        if (is_sp_nan(vf1) || is_sp_nan(vf2)) {
          // @todo: set invalid
          this.registerWrite(d.rd, 0n);
        } else {
          const signA = vf1 >> 31n;
          const signB = vf2 >> 31n;
          const magA = vf1 & 0x7fffffffn;
          const magB = vf2 & 0x7fffffffn;
          const eq = vf1 === vf2 || (magA === 0n && magB === 0n);
          if (eq) {
            this.registerWrite(d.rd, eq ? 1n : 0n);
            return;
          }

          let lt = false;
          if (signA !== signB) {
            lt = !!signA && !(magA === 0n && magB === 0n);
          } else if (signA === 0n) {
            lt = vf1 < vf2;
          } else {
            lt = vf1 > vf2;
          }

          this.registerWrite(d.rd, lt ? 1n : 0n);
        }
        return;
      case rv_opcode["fclass.s"]:
        if (is_sp_neg_inf(vf1)) {
          this.registerWrite(d.rd, 1n << 0n);
        } else if (is_sp_neg_norm(vf1)) {
          this.registerWrite(d.rd, 1n << 1n);
        } else if (is_sp_neg_subnorm(vf1)) {
          this.registerWrite(d.rd, 1n << 2n);
        } else if (is_sp_neg_zero(vf1)) {
          this.registerWrite(d.rd, 1n << 3n);
        } else if (is_sp_pos_zero(vf1)) {
          this.registerWrite(d.rd, 1n << 4n);
        } else if (is_sp_pos_subnorm(vf1)) {
          this.registerWrite(d.rd, 1n << 5n);
        } else if (is_sp_pos_norm(vf1)) {
          this.registerWrite(d.rd, 1n << 6n);
        } else if (is_sp_pos_inf(vf1)) {
          this.registerWrite(d.rd, 1n << 7n);
        } else if (is_sp_signaling_nan(vf1)) {
          this.registerWrite(d.rd, 1n << 8n);
        } else {
          // assert(is_sp_quiet_nan(vf1), "Unexpected SP value");
          this.registerWrite(d.rd, 1n << 9n);
        }
        return;
      case rv_opcode["fcvt.s.w"]: {
        // @todo rounding mode
        this.registerWriteF(d.rd, f_to_biguint(Number(s32(v1))));
        return;
      }
      case rv_opcode["fcvt.s.wu"]: {
        // @todo rounding mode
        this.registerWriteF(d.rd, f_to_biguint(Number(u32(v1))));
        return;
      }
      case rv_opcode["fmv.w.x"]:
        this.registerWriteF(d.rd, v1);
        return;
    }
  }

  public step() {
    this.beginUndoFrame();

    const inst = this.fetch();
    const dec = this.decode(inst);

    if (dec.codec === rv_codec.illegal) {
      console.log("cpu.step: stepped into illegal instruction, halting", {
        halted: this.halted,
        inst,
        dec,
        pc: this.cpu.pc,
      });

      this.setHalted(true);
      this.commitUndoFrame();

      return;
    }

    this._pcWritten = false;
    const ret = this.execute(dec);
    if (!this._pcWritten) {
      this.cpu.pc += 4n;
    }

    this.commitUndoFrame();

    return ret;
  }

  protected beginUndoFrame() {
    super.beginUndoFrame();

    if (this._undoFrame) {
      (this._undoFrame as IRVStepUndoFrame).registersF = {};
    }
  }

  protected applyUndoFrame(frame: IStepUndoFrame<IDecodedRVInstruction>) {
    super.applyUndoFrame(frame);

    const registersF = (frame as IRVStepUndoFrame).registersF;
    for (const reg of Object.keys(registersF)) {
      this.cpu.registerF[Number(reg)] = registersF[Number(reg)];
    }
  }

  public stringifyInstruction(instruction: Partial<IDecodedRVInstruction>): string {
    const opcode = instruction._op || rv_opcode.illegal;
    const rd = instruction.rd ?? 0;
    const rs1 = instruction.rs1 ?? 0;
    const rs2 = instruction.rs2 ?? 0;
    const rs3 = instruction.rs3 ?? 0;
    const imm = instruction.imm || 0n;

    const op_info = RV_OPCODE_DATA[opcode];
    const rv32im = op_info.extension === rv_ext.RV32I || op_info.extension === rv_ext.RV32M;
    const rv32f = op_info.extension === rv_ext.RV32F;
    const fmt = op_info.format;
    let str = "";

    if (instruction._op === rv_opcode.ebreak || instruction._op === rv_opcode.ecall) {
      return op_info.name;
    }

    for (const c of fmt) {
      if (c === "O") {
        str += op_info.name;
      } else if (c === "d") {
        if (
          rv32im ||
          [
            rv_opcode["fmv.x.w"],
            rv_opcode["fcvt.w.s"],
            rv_opcode["fcvt.wu.s"],
            rv_opcode["feq.s"],
            rv_opcode["flt.s"],
            rv_opcode["fle.s"],
            rv_opcode["fclass.s"],
          ].includes(opcode)
        ) {
          str += rv_reg[rd];
        } else if (rv32f) {
          str += rv_reg_f[rd];
        }
      } else if (c === "1") {
        if (rv32im || [rv_opcode["fmv.w.x"], rv_opcode["fcvt.s.w"], rv_opcode["fcvt.s.wu"]].includes(opcode)) {
          str += rv_reg[rs1];
        } else if (rv32f) {
          str += rv_reg_f[rs1];
        }
      } else if (c === "2") {
        if (rv32im || rv_opcode.flw === opcode) {
          str += rv_reg[rs2];
        } else if (rv32f) {
          str += rv_reg_f[rs2];
        }
      } else if (c === "3") {
        if (rv32im) {
          str += rv_reg[rs3];
        } else if (rv32f) {
          str += rv_reg_f[rs3];
        }
      } else if (c === "i") {
        const bc = instruction.bytecode ?? 0n;
        if (op_info.codec === rv_codec.i) {
          str += operand_iimm12(bc);
        } else if (op_info.codec === rv_codec.s) {
          str += operand_simm12(bc);
        } else {
          str += imm;
        }
      } else if (c === "x") {
        str += "0x" + BigInt.asUintN(this.XLEN, imm).toString(16).toUpperCase();
      } else if (c === "X") {
        str += "0x" + BigInt.asUintN(this.XLEN, imm).toString(16).toUpperCase().padStart(8, "0");
      } else if (c === "j") {
        str += imm;
      } else {
        str += c;
      }
    }

    return str;
  }

  protected registerRead(reg: number) {
    if (reg === rv_reg.zero) {
      return 0n;
    }

    return super.registerRead(reg);
  }

  protected registerReadFloat32(reg: number) {
    if (reg > rv_reg_f.f31) {
      throw new Error("RVSIM: inexistent RV32F register: " + reg);
    }

    return this.cpu.registerF[reg];
  }

  protected registerWrite(reg: number, value: bigint) {
    if (reg === rv_reg.sp && value > this.STACK_START) {
      throw new Error(`stack overflow; register[sp] (${value}) > STACK_START (${value})`);
    }

    if (reg !== rv_reg.zero) {
      return super.registerWrite(reg, value & this.REG_MASK);
    }
  }

  protected registerWriteF(reg: number, value: bigint) {
    if (reg > rv_reg_f.f31) {
      throw new Error("RVSIM: inexistent RV32F register: " + reg);
    }

    const undoFrame = this._undoFrame as IRVStepUndoFrame | null;
    if (undoFrame && !(reg in undoFrame.registersF)) {
      undoFrame.registersF[reg] = this.cpu.registerF[reg];
    }

    this._dbgRegChanges.push({
      reg: rv_reg_f[reg],
      value: (this.cpu.registerF[reg] = u32(value)),
      cycle: this.cycle,
      pc: this.cpu.pc,
    });
  }

  public loadProgram(program: Array<IAssembledInstruction<IDecodedRVInstruction>>) {
    if (this.memory.length > 0) {
      this.memory.fill(0);
    }

    this.cycle = 0;
    this.cpu.pc = program[0]?.address ?? this.PC_START;
    this.cpu.register[rv_reg.sp] = this.STACK_START;

    for (const v of program) {
      // @todo aceitar bytes
      this.memoryWrite(v.address, v.decoded.bytecode, 32);
    }
  }

  // @todo rewrite; this function sucks
  public getRegistersReadable(cpu: IRVCPU) {
    const reg: IRegisterReadable = {
      pc: {
        regStr: "pc",
        value: cpu.pc,
        str: cpu.pc.toString(10),
      },
    };

    for (const [r, v] of Object.entries(cpu.register)) {
      // @ts-expect-error @todo bleeeeeeeeeeeeeeh
      const regStr = `${rv_reg_alias[rv_reg[r]].padEnd(3, " ")} (${rv_reg[r]})`;

      reg[rv_reg[r as unknown as number]] = {
        regStr,
        value: v,
        str: v.toString(10),
      };
    }

    if (this.extensions & rv_ext.RV32F) {
      for (const [r, v] of Object.entries(cpu.registerF)) {
        // @ts-expect-error @todo bleeeeeeeeeeeeeeh
        const regStr = rv_reg_alias[rv_reg_f[r]].padEnd(3, " ") + ` (${rv_reg_f[r]})`.padEnd(7, " ");

        reg[rv_reg_f[r as unknown as number]] = {
          regStr,
          value: v,
          str: biguint32_to_f(v).toString(10),
        };
      }
    }

    return reg;
  }
}
