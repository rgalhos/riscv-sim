import { ScreenWindow } from "@/components/screen/ScreenWindow.component";
import { SimulatorSettingsDialog } from "@/components/simulator-settings/SimulatorSettingsDialog.component";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EWorkerCommand, type WorkerMessageResponse } from "@/hardware/common/worker-service";
import { useSimulator } from "@/lib/contexts/simulator.context";
import { Hammer, Monitor, Pause, Play, Settings, StepForward, Terminal, UndoDot } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

export function MemoSimulatorActions(props: {
  pendingChanges: boolean;
  onAssemble: () => void;
  onToggleExecution: () => void;
  onStep: () => void;
  onStepBack: () => void;
  onToggleConsole: () => void;
}) {
  const { simulator } = useSimulator();
  const [cpuHalted, setCpuHalted] = useState(true);
  const [canStepBack, setCanStepBack] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);

  useEffect(() => {
    const ws = simulator.workerService;

    const onCpuDump = (response: Extract<WorkerMessageResponse, { command: EWorkerCommand.CPU_DUMP }>) => {
      // @todo BAD PRACTICE: It also syncs the state of the CPU outside the worker
      simulator.processor.cpu = response.data.cpu;
      simulator.processor.setHalted(response.data.halted);
      simulator.processor.lastExecutedInstruction = response.data.lastExecutedInstruction;
      simulator.processor.cycle = response.data.cycle;

      setCpuHalted((prev) => (prev === response.data.halted ? prev : response.data.halted));
      setCanStepBack((prev) => (prev === response.data.canStepBack ? prev : response.data.canStepBack));
    };

    ws.on(EWorkerCommand.CPU_DUMP, onCpuDump);

    return () => {
      ws.off(EWorkerCommand.CPU_DUMP, onCpuDump);
    };
  }, [simulator]);

  const simulatorActions = useMemo<
    Array<{ Icon: React.ReactElement; label: string; action: () => void; disabled?: boolean }>
  >(
    () => [
      {
        Icon: cpuHalted ? <Play color="var(--catppuccin-green)" /> : <Pause color="var(--catppuccin-red)" />,
        label: cpuHalted ? "Run program" : "Pause program",
        action: props.onToggleExecution,
      },
      {
        Icon: <UndoDot color="var(--catppuccin-blue)" />,
        label: "Step back",
        disabled: !canStepBack,
        action: props.onStepBack,
      },
      {
        Icon: <StepForward color="var(--catppuccin-blue)" />,
        label: "Step one instruction",
        action: props.onStep,
      },
      { Icon: <Settings />, label: "Simulator settings", action: () => setSettingsOpen(true) },
    ],
    [props, cpuHalted, canStepBack]
  );

  const simulatorTools = useMemo(
    () => [
      { Icon: <Terminal />, label: "Open terminal", action: props.onToggleConsole },
      { Icon: <Monitor />, label: "Open screen", action: () => setScreenOpen(!screenOpen) },
    ],
    [props, screenOpen]
  );

  return (
    <>
      <div className="ml-2 flex items-center gap-2 border-x px-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  props.pendingChanges
                    ? "Your program was modified. Do not forget to reassemble ;)"
                    : "Assemble program"
                }
                onClick={props.onAssemble}
              />
            }
          >
            <Hammer />

            {props.pendingChanges && (
              <div
                style={{
                  marginTop: "-14px",
                  marginRight: "-22px",
                  position: "absolute",
                  width: "8px",
                  height: "8px",
                  background: "var(--catppuccin-red)",
                  borderRadius: "999px",
                }}
              />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {props.pendingChanges ? "Your program was modified. Do not forget to reassemble ;)" : "Assemble program"}
          </TooltipContent>
        </Tooltip>

        {simulatorActions.map(({ Icon, label, action, disabled }) => (
          <Tooltip key={label}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled ?? false}
                  aria-label={label}
                  onClick={action}
                />
              }
            >
              {Icon}
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="flex items-center gap-2 border-r px-2">
        {simulatorTools.map(({ Icon, label, action }) => (
          <Tooltip key={label}>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={action} />}>
              {Icon}
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <SimulatorSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ScreenWindow open={screenOpen} onClose={() => setScreenOpen(false)} />
    </>
  );
}

export const SimulatorActions = memo(MemoSimulatorActions);
