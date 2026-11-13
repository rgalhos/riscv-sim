import type { ISimulator } from "@/hardware/common/simulator";
import { RVSimulator } from "@/hardware/rv32/rv32.simulator";
import { getStepSpeed } from "@/lib/stores/settings.store";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

const SimulatorContext = createContext(
  {} as {
    simulator: ISimulator;
    setSimulator: (simulator: ISimulator) => void;
    createSimulatorWorker: () => void;
  }
);

export const SimulatorProvider = ({ children }: { children: React.ReactNode }) => {
  const [simulator, setSimulator] = useState<ISimulator>(() => {
    const sim = new RVSimulator();
    sim.processor.setFrequency(getStepSpeed());
    return sim;
  });

  const createSimulatorWorker = useCallback(() => {
    if (!simulator.workerService.worker) {
      simulator.createCpuWorker();
      simulator.workerService.requestCpuDump();
      simulator.setFrequency(getStepSpeed());
    }
  }, [simulator]);

  const value = useMemo(
    () => ({ simulator, setSimulator, createSimulatorWorker }),
    [simulator, createSimulatorWorker]
  );

  return (
    <SimulatorContext.Provider value={value}>
      {children}
    </SimulatorContext.Provider>
  );
};

export const useSimulator = () => useContext(SimulatorContext);
