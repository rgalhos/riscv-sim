import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ISimulator } from "@/hardware/common/simulator";
import { EWorkerCommand, type IWorkerCPUDebugDump, type WorkerMessageResponse } from "@/hardware/common/worker-service";
import { useSimulator } from "@/lib/contexts/simulator.context";
import { cn, debounce, fmtWordHex } from "@/lib/utils";
import { Trash2 } from "lucide-react";
import { type KeyboardEvent, memo, useEffect, useRef, useState } from "react";

const STDIN_MAX_LEN = 255;
const TERMINAL_MAX_CHARS = 100_000;

const enum ETabs {
  TERMINAL,
  DEBUG,
}

const consoleTextareaClassName = cn(
  "min-h-[240px] w-full resize-none border border-input bg-background px-3 py-2 text-foreground",
  "select-text placeholder:text-muted-foreground focus-visible:outline-none"
);

function ConsoleClearButton({ onClear }: { onClear: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClear}
      aria-label="Clear console"
      className="absolute top-0 right-4 z-10"
    >
      <Trash2 />
    </Button>
  );
}

const ConsoleTerminal = memo(function MemoConsoleTerminal({ simulator }: { simulator: ISimulator }) {
  const terminalInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLTextAreaElement>(null);
  const [terminalValue, setTerminalValue] = useState("");

  const handleClearTerminal = () => {
    setTerminalValue("");
  };

  function submitInput() {
    const value = terminalInputRef.current?.value;
    if (!value) return;

    setTerminalValue((curr) => curr + value + "\n");
    terminalInputRef.current!.value = "";

    simulator.handleStdinInput(value);
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitInput();
    }
  }

  useEffect(() => {
    let pending = "";
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      const chunk = pending;
      pending = "";
      setTerminalValue((prev) => {
        const next = prev + chunk;
        return next.length > TERMINAL_MAX_CHARS ? next.slice(next.length - TERMINAL_MAX_CHARS) : next;
      });
    };

    const onMessage = (response: Extract<WorkerMessageResponse, { command: EWorkerCommand.TERMINAL_PRINT }>) => {
      pending += response.data;
      if (frame === null) frame = requestAnimationFrame(flush);
    };

    const onReset = () => {
      pending = "";
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      handleClearTerminal();
    };

    simulator.workerService.on(EWorkerCommand.CPU_RESET, onReset);
    simulator.workerService.on(EWorkerCommand.TERMINAL_PRINT, onMessage);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      simulator.workerService.off(EWorkerCommand.CPU_RESET, onReset);
      simulator.workerService.off(EWorkerCommand.TERMINAL_PRINT, onMessage);
    };
  }, [simulator]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalValue]);

  return (
    <div className="relative flex flex-col font-mono">
      <ConsoleClearButton onClear={handleClearTerminal} />

      <textarea
        ref={terminalRef}
        readOnly
        value={terminalValue}
        placeholder="Empty"
        rows={10}
        className={consoleTextareaClassName}
      />

      <input
        ref={terminalInputRef}
        onKeyDown={handleInputKeyDown}
        placeholder="Terminal input"
        maxLength={STDIN_MAX_LEN}
        className={cn(
          "h-8 w-full border border-input bg-background px-3 text-foreground",
          "placeholder:text-muted-foreground focus-visible:outline-none"
        )}
      />
    </div>
  );
});

const DebugTerminal = memo(function MemoDebugTerminal({ simulator }: { simulator: ISimulator }) {
  const debugRef = useRef<HTMLTextAreaElement>(null);
  const debugBuffer = useRef<string[]>([]);
  const [debugValue, setDebugValue] = useState("");

  const handleClearDebug = () => {
    setDebugValue("");
  };

  useEffect(() => {
    if (debugRef.current) {
      debugRef.current.scrollTop = debugRef.current.scrollHeight;
    }
  }, [debugValue]);

  const flushDebug = () => {
    if (debugBuffer.current.length) {
      setDebugValue((old) => old.slice(-10000) + debugBuffer.current.join(""));
      debugBuffer.current = [];
    }
  };

  useEffect(() => {
    const updateDebugValue = debounce(flushDebug, 100);

    const onDump = (response: Extract<WorkerMessageResponse, { command: EWorkerCommand.CPU_DEBUG_DUMP }>) => {
      [...response.data.registers, ...response.data.memory]
        .sort((a, b) => Number(a.pc - b.pc))
        .forEach((evt) => {
          if (typeof (evt as IWorkerCPUDebugDump["registers"][0]).reg !== "undefined") {
            const r = evt as IWorkerCPUDebugDump["registers"][0];

            debugBuffer.current.push(
              `[cycle ${r.cycle}] [pc ${fmtWordHex(r.pc)}] reg[${r.reg}] = ${fmtWordHex(r.value)}\n`
            );
          } else {
            const r = evt as IWorkerCPUDebugDump["memory"][0];

            debugBuffer.current.push(
              `[cycle ${r.cycle}] [pc ${fmtWordHex(r.pc)}] ` +
                `mem[${fmtWordHex(r.address)}] = ${fmtWordHex(r.value)}\n`
            );
          }
        });

      if (debugBuffer.current.length > 100) {
        flushDebug();
      }

      updateDebugValue();
    };

    simulator.workerService.on(EWorkerCommand.CPU_DEBUG_DUMP, onDump);

    return () => {
      simulator.workerService.off(EWorkerCommand.CPU_DEBUG_DUMP, onDump);
    };
  }, [simulator]);

  return (
    <div className="relative flex flex-col font-mono">
      <ConsoleClearButton onClear={handleClearDebug} />

      <textarea
        ref={debugRef}
        readOnly
        id="debugTxtArea"
        value={debugValue}
        placeholder="Empty"
        rows={10}
        className={consoleTextareaClassName}
      />
    </div>
  );
});

function MemoConsoleContainer() {
  const { simulator } = useSimulator();
  const [activeTab, setActiveTab] = useState<ETabs>(ETabs.TERMINAL);

  return (
    <Tabs value={activeTab} onValueChange={(tab) => setActiveTab(tab)} className="mt-4 flex flex-col">
      <TabsList variant="line">
        <TabsTrigger value={ETabs.TERMINAL}>Terminal</TabsTrigger>
        <TabsTrigger value={ETabs.DEBUG}>Debug</TabsTrigger>
      </TabsList>

      <TabsContent value={ETabs.TERMINAL} keepMounted>
        <ConsoleTerminal simulator={simulator} />
      </TabsContent>

      <TabsContent value={ETabs.DEBUG} keepMounted>
        <DebugTerminal simulator={simulator} />
      </TabsContent>
    </Tabs>
  );
}

export const ConsoleContainer = memo(MemoConsoleContainer);
