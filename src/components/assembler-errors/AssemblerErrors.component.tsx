import type { IDiagnostic } from "@/hardware/rv32/language-service/rv32.diagnostics";
import { useEditor } from "@/lib/contexts/editor.context";
import { cn } from "@/lib/utils";
import { TriangleAlertIcon } from "lucide-react";

export function AssemblerErrors({ diagnostics }: { diagnostics: IDiagnostic[] }) {
  const { focusLine } = useEditor();

  if (diagnostics.length === 0) {
    return null;
  }

  return (
    <div className="my-2 flex shrink-0 flex-col gap-1.5 border-t border-border">
      {diagnostics.map((d, i) => {
        const line = d.range.start.line + 1;

        return (
          <div
            key={`errorno-${i}`}
            role="alert"
            className={cn(
              "flex cursor-pointer items-start gap-2 border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive"
            )}
            onClick={() => focusLine(line)}
          >
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Line {line}: {d.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}
