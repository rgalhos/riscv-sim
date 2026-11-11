import { AssemblerErrors } from "@/components/assembler-errors/AssemblerErrors.component";
import { SimulatorActions } from "@/components/simulator-actions/SimulatorActions.component";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConsoleContainer } from "@/containers/console/Console.container";
import { EditorContainer } from "@/containers/editor/Editor.container";
import { HexViewContainer } from "@/containers/hex-view/HexView.container";
import { MemoryViewContainer } from "@/containers/memory-view/MemoryView.container";
import { RegisterViewContainer } from "@/containers/register-view/RegisterView.container";
import type { IAssemblerResult } from "@/hardware/common/simulator";
import { errorsToDiagnostics, type IDiagnostic } from "@/hardware/rv32/language-service/rv32.diagnostics";
import { useEditor } from "@/lib/contexts/editor.context";
import { useSimulator } from "@/lib/contexts/simulator.context";
import { $settings } from "@/lib/stores/settings.store";
import { $simulatorTab, ETabs, setSimulatorTab } from "@/lib/stores/simulator-tab.store";
import { cn } from "@/lib/utils";
import { useStore } from "@nanostores/react";
import { Fragment, startTransition, useCallback, useLayoutEffect, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";

const CONSOLE_DEFAULT_SIZE = "340px";

export function SimulatorContainer() {
  const { simulator, createSimulatorWorker } = useSimulator();
  const { editor, focusLine } = useEditor();

  const [program, setProgram] = useState<IAssemblerResult>({ instructions: [], labels: {}, errors: [] });
  const [diagnostics, setDiagnostics] = useState<IDiagnostic[]>([]);
  const [pendingChanges, setPendingChanges] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const activeTab = useStore($simulatorTab);
  const consolePanelRef = usePanelRef();

  useLayoutEffect(() => {
    consolePanelRef.current?.collapse();
  }, [consolePanelRef]);

  function handleEditorChange() {
    setPendingChanges(true);
  }

  const onAssemble = useCallback(() => {
    if (!editor) {
      console.error("No editor!", { editor });
      return;
    }

    const code = editor.getValue() as string;

    createSimulatorWorker();

    try {
      const t0 = performance.now();
      const assembled = simulator.assembleCode(code);
      const t1 = performance.now();

      console.log(`perf: Code assemble took ${t1 - t0}ms`);

      setPendingChanges(false);
      startTransition(() => {
        setProgram(assembled);
        setDiagnostics(errorsToDiagnostics(assembled.errors, code));
      });

      if (assembled.errors.length > 0) {
        console.log(`assembler: program contains ${assembled.errors.length} errors. not syncing with worker.`);
        return;
      }

      simulator.syncWorker();

      toast.success("Your code has been assembled.");
    } catch (e) {
      toast.error("err: " + e?.toString());
    }
  }, [editor, simulator, createSimulatorWorker]);

  const onToggleExecution = useCallback(() => {
    if (!simulator) {
      console.log("onToggleExecution: no simulator?????");
      return;
    } else if (!simulator.workerService.worker) {
      onAssemble();
    }

    if (program.errors.length > 0) {
      toast.warning("Fix all compilation errors and recompile before running", {
        action: { label: "Show errors", onClick: () => setSimulatorTab(ETabs.EDITOR) },
      });

      return;
    }

    if (simulator.processor.halted) {
      simulator.workerService.runCode();
    } else {
      simulator.workerService.setHalted(true);
    }
  }, [simulator, onAssemble, program]);

  const onStepBack = useCallback(() => {
    if (!simulator || !simulator.workerService.worker) {
      console.log("No simulator or worker");
      return;
    }

    simulator.workerService.stepBack();

    if ($settings.get().focusOnStep) {
      const t = setTimeout(() => {
        clearTimeout(t);

        const line = program.instructions.find(({ address }) => address === simulator.processor.cpu.pc)?.lineNumber;
        if (line) focusLine(line);
      }, 15);
    }
  }, [simulator, program, focusLine]);

  const onStep = useCallback(() => {
    if (!simulator || !simulator.workerService.worker) {
      console.log("No simulator or worker");
      return;
    }

    if (program.errors.length > 0) {
      toast.warning("Fix all compilation errors and recompile before running", {
        action: { label: "Show errors", onClick: () => setSimulatorTab(ETabs.EDITOR) },
      });

      return;
    }

    simulator.workerService.stepCode();

    if ($settings.get().focusOnStep) {
      const t = setTimeout(() => {
        clearTimeout(t);

        const line = program.instructions.find(({ address }) => address === simulator.processor.cpu.pc)?.lineNumber;
        if (line) focusLine(line);
      }, 15);
    }
  }, [simulator, program, focusLine]);

  const onToggleConsole = useCallback(() => {
    const panel = consolePanelRef.current;
    if (!panel) return;

    if (panel.isCollapsed()) {
      panel.resize(CONSOLE_DEFAULT_SIZE);
      setConsoleOpen(true);
    } else {
      panel.collapse();
      setConsoleOpen(false);
    }
  }, [consolePanelRef]);

  return (
    <Fragment>
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel className="flex min-h-0 flex-col overflow-hidden">
          <Tabs
            value={activeTab}
            onValueChange={(tab) => setSimulatorTab(tab as ETabs)}
            className="flex min-h-0 w-full flex-1 flex-col"
          >
            <div className="sticky top-0 z-10 shrink-0 bg-background">
              <TabsList variant="line" className="my-2">
                <TabsTrigger value={ETabs.EDITOR}>Editor</TabsTrigger>
                <TabsTrigger value={ETabs.HEX_VIEW}>Hex view</TabsTrigger>
                <TabsTrigger value={ETabs.MEMORY}>Memory</TabsTrigger>

                <SimulatorActions
                  pendingChanges={pendingChanges}
                  onAssemble={onAssemble}
                  onToggleExecution={onToggleExecution}
                  onStep={onStep}
                  onStepBack={onStepBack}
                  onToggleConsole={onToggleConsole}
                />
              </TabsList>
            </div>

            <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
              <ResizablePanel defaultSize="66.67%" className="flex min-h-0 flex-col overflow-hidden">
                <TabsContent value={ETabs.EDITOR} keepMounted className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <AssemblerErrors diagnostics={diagnostics} />

                  <EditorContainer handleEditorChange={handleEditorChange} />
                </TabsContent>

                <TabsContent value={ETabs.HEX_VIEW} keepMounted className="flex min-h-0 flex-1 flex-col">
                  <HexViewContainer program={program} visible={activeTab === ETabs.HEX_VIEW} />
                </TabsContent>

                <TabsContent value={ETabs.MEMORY} keepMounted className="flex min-h-0 flex-1 flex-col">
                  <MemoryViewContainer visible={activeTab === ETabs.MEMORY} />
                </TabsContent>
              </ResizablePanel>

              <ResizableHandle withHandle className="mx-4" />

              <ResizablePanel
                defaultSize="400px"
                maxSize="500px"
                minSize="50px"
                className="flex min-h-0 flex-col overflow-auto"
              >
                <RegisterViewContainer />
              </ResizablePanel>
            </ResizablePanelGroup>
          </Tabs>
        </ResizablePanel>

        <ResizableHandle withHandle disabled={!consoleOpen} className={cn("mt-4", !consoleOpen && "hidden")} />

        <ResizablePanel
          id="console"
          panelRef={consolePanelRef}
          collapsible
          collapsedSize={0}
          defaultSize={CONSOLE_DEFAULT_SIZE}
          maxSize="500px"
          minSize="200px"
          className="flex min-h-0 flex-col overflow-auto"
        >
          <ConsoleContainer />
        </ResizablePanel>
      </ResizablePanelGroup>
    </Fragment>
  );
}
