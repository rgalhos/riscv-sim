import { SharedMemory } from "../common/shared-memory";
import type { WorkerMessage, WorkerMessageResponse } from "../common/worker-service";
import { EWorkerCommand } from "../common/worker-service";
import { rv_worker_commands } from "./rv32.const";
import { RVProcessor } from "./rv32.processor";
import type { IRVCPU } from "./rv32.types";

const cpu = new RVProcessor();
let usingSharedMemory = false;

const postMessage = (message: WorkerMessageResponse) => {
  self.postMessage(message);
};

const postCpuDump = () => {
  const memoryDiff = cpu._memoryOperationDiff;
  cpu._memoryOperationDiff = {};

  postMessage({
    command: EWorkerCommand.CPU_DUMP,
    data: {
      memoryDiff,
      cpu: {
        pc: cpu.cpu.pc,
        register: cpu.cpu.register,
        registerF: cpu.cpu.registerF,
      },
      halted: cpu.halted,
      cycle: cpu.cycle,
      lastExecutedInstruction: cpu.lastExecutedInstruction,
      canStepBack: cpu.canStepBack,
    },
  });

  postMessage({
    command: EWorkerCommand.CPU_DEBUG_DUMP,
    data: {
      memory: cpu._dbgMemChanges,
      registers: cpu._dbgRegChanges,
    },
  });

  cpu._dbgMemChanges = [];
  cpu._dbgRegChanges = [];
};

// const shouldPostDumpAfterStep = () => cpu.halted || cpu.cycle % Math.max(100, Math.ceil(cpu.frequency / 10)) === 0;

let nextDump = 0;

function shouldPostDumpAfterStep() {
  if (cpu.halted) return true;

  if (cpu.cycle < nextDump) {
    return false;
  }

  nextDump += cpu.frequency / 60;
  return true;
}

let runGeneration = 0;

const cancelRunLoop = () => {
  runGeneration++;
  cpu.setHalted(true);
};

const reportCpuFault = (error: unknown) => {
  cpu.setHalted(true);

  const message = error instanceof Error ? error.message : String(error);
  const report = `[cpu halted at pc=0x${cpu.cpu.pc.toString(16)}] ${message}`;

  console.log(report);

  postMessage({
    command: EWorkerCommand.TERMINAL_PRINT,
    data: `\n${report}\n`,
  });

  postCpuDump();
};

const handleCpuStep = () => {
  let ret: number;

  try {
    ret = +cpu.step();
  } catch (error) {
    reportCpuFault(error);
    return;
  }

  if (ret & rv_worker_commands.SYNC_LISTENERS) {
    postCpuDump();
  } else if (shouldPostDumpAfterStep() || ret & rv_worker_commands.UPDATE_FRAMEBUFFER) {
    postCpuDump();
  }

  if (ret & rv_worker_commands.PRINT_STRING) {
    postMessage({ command: EWorkerCommand.TERMINAL_PRINT, data: String(cpu._workerBuffer) });
  }

  if (ret & rv_worker_commands.UPDATE_FRAMEBUFFER) {
    //@ts-expect-error data: never
    postMessage({ command: EWorkerCommand.UPDATE_SCREEN });
  }
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const startRunLoop = async () => {
  const generation = ++runGeneration;
  const isCurrent = () => generation === runGeneration && !cpu.halted;
  const t0 = Date.now();
  let nextDeadline = Date.now();

  while (isCurrent()) {
    // @todo colocar aqui resolve o bug de nao mudar a fred...
    // mas não sei se causa uma grande penalidade de performance
    const freq = Number.isFinite(cpu.frequency) ? Math.max(1, cpu.frequency) : 1000;
    const cyclesPerWake = Math.max(1, Math.ceil(freq / 1000));
    const sliceMs = (cyclesPerWake * 1000) / freq;

    for (let i = 0; i < cyclesPerWake && isCurrent(); i++) {
      handleCpuStep();
    }

    nextDeadline += sliceMs;
    const delay = nextDeadline - Date.now();

    if (delay > 0) {
      await sleep(delay);
    }
  }

  const t1 = Date.now();

  const tDelta = t1 - t0;
  console.log(`perf: Program execution took ${tDelta}ms and ${cpu.cycle} cycles. (${cpu.cycle / (tDelta / 1000)}Hz)`);
};

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { command, data } = event.data;

  console.log("cpu worker:", { command, data, cpu });

  if (command === EWorkerCommand.CPU_SETUP) {
    cpu.attachMemory(SharedMemory.attach(data.sharedBuffer, data.memorySize));
    cpu.setMemorySize(data.memorySize);
    usingSharedMemory = data.sharedBuffer instanceof SharedArrayBuffer;
  } else if (command === EWorkerCommand.CPU_RESET) {
    cancelRunLoop();
    cpu.resetState();
    nextDump = 0;
  } else if (command === EWorkerCommand.CPU_RUN) {
    cpu.setHalted(!cpu.halted);

    if (cpu.halted) {
      cancelRunLoop();
    } else {
      startRunLoop();
    }

    postCpuDump();
  } else if (command === EWorkerCommand.CPU_STEP) {
    cancelRunLoop();
    cpu.setHalted(true);

    handleCpuStep();
  } else if (command === EWorkerCommand.CPU_STEP_BACK) {
    cancelRunLoop();
    cpu.setHalted(true);

    cpu.stepBack();
    postCpuDump();
  } else if (command === EWorkerCommand.SET_CPU_HALT) {
    if (data) {
      cancelRunLoop();
    }
    cpu.setHalted(data);

    postCpuDump();
  } else if (command === EWorkerCommand.GET_CPU_HALT) {
    postMessage({ command: EWorkerCommand.GET_CPU_HALT, data: cpu.halted });
  } else if (command === EWorkerCommand.SET_FREQUENCY) {
    cpu.setFrequency(data);
  } else if (command === EWorkerCommand.GET_FREQUENCY) {
    postMessage({ command: EWorkerCommand.GET_FREQUENCY, data: cpu.frequency });
  } else if (command === EWorkerCommand.LOAD_PROGRAM) {
    cancelRunLoop();
    console.log("cpu worker: debug: program loaded", { program: data, cpu });

    cpu.loadProgram(data as Parameters<RVProcessor["loadProgram"]>[0]);
    nextDump = 0;

    postCpuDump();
  } else if (command === EWorkerCommand.MEMORY_RETRIEVE) {
    //@ts-expect-error data: never
    postMessage({ command: EWorkerCommand.MEMORY_RETRIEVE });
  } else if (command === EWorkerCommand.CPU_DUMP) {
    postCpuDump();
  } else if (command === EWorkerCommand.ASSEMBLE_CODE) {
    //cpu.assembleCode(code:)
  } else if (command === EWorkerCommand.SET_MEMORY_SIZE) {
    cpu.setMemorySize(data);
  } else if (command === EWorkerCommand.SYNC_WORKER) {
    cancelRunLoop();
    cpu.resetState({ clearMemory: !usingSharedMemory && !data.memory });
    nextDump = 0;

    cpu.cpu = data.cpu as IRVCPU;

    if (data.memory) {
      cpu.attachMemory(data.memory);
      usingSharedMemory = false;
    }

    cpu.setMemorySize(data.memorySize);
    cpu.setFrequency(data.frequency);
    cpu.optExplicitScreenUpdate = data.optExplicitScreenUpdate;

    postCpuDump();
    //@ts-expect-error data: never
    postMessage({ command: EWorkerCommand.CPU_RESET });
  } else if (command === EWorkerCommand.KEY_EVENT) {
    cpu.memoryWrite(cpu.KBD_STAT, 1n, 8);
    cpu.memoryWrite(cpu.KBD_DATA, BigInt(data), 8);
  } else if (command === EWorkerCommand.STDIN_EVENT) {
    const line = String(data || "").slice(0, cpu.STDIN_SIZE - 1);

    for (let i = 0; i < line.length; i++) {
      cpu.memoryWrite(cpu.STDIN_DATA + BigInt(i), BigInt(line.charCodeAt(i)), 8);
    }

    cpu.memoryWrite(cpu.STDIN_DATA + BigInt(line.length), 0n, 8);
    cpu.memoryWrite(cpu.STDIN_STAT, BigInt(line.length), 8);
  }
};

export {};
