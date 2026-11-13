import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSimulator } from "@/lib/contexts/simulator.context";
import { $settings, MAX_STEP_SPEED, sanitizeStepSpeed } from "@/lib/stores/settings.store";
import { useStore } from "@nanostores/react";
import { useRef, useState, type JSX } from "react";

export function SimulatorSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { simulator } = useSimulator();
  const settings = useStore($settings);
  const stepSpeedInputRef = useRef<HTMLInputElement>(null);
  const [focusStepChecked, setFocusStepChecked] = useState(settings.focusOnStep);

  // @todo insane
  const onSubmit = (e: Parameters<Exclude<JSX.IntrinsicElements["form"]["onSubmit"], undefined>>[0]) => {
    e.preventDefault();

    const stepSpeed = sanitizeStepSpeed(stepSpeedInputRef.current!.value);

    $settings.set({
      stepSpeed,
      focusOnStep: focusStepChecked,
    });

    simulator.setFrequency(stepSpeed);

    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <form id="rvsim-settings" onSubmit={onSubmit}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Simulator settings</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <Label htmlFor="speed">Simulation speed (Hz)</Label>
              <Input
                id="speed"
                name="speed"
                type="number"
                min={1}
                max={MAX_STEP_SPEED}
                step={1}
                required
                defaultValue={sanitizeStepSpeed(settings.stepSpeed)}
                ref={stepSpeedInputRef}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="focus-step"
                name="focus-step"
                checked={focusStepChecked}
                onCheckedChange={setFocusStepChecked}
              />
              <Label htmlFor="focus-step">Focus editor when stepping</Label>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="rvsim-settings">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}
