import {
  DIAGNOSTIC_SOURCE,
  EDiagnosticSeverity,
  getDiagnostics,
  type IDiagnostic,
} from "@/hardware/rv32/language-service/rv32.diagnostics";
import type { Monaco, OnMount } from "@monaco-editor/react";

type TEditor = Parameters<OnMount>[0];

const DIAGNOSTICS_DELAY_MS = 300;

function toMarkerSeverity(monaco: Monaco, severity: EDiagnosticSeverity) {
  switch (severity) {
    case EDiagnosticSeverity.Warning:
      return monaco.MarkerSeverity.Warning;
    case EDiagnosticSeverity.Information:
      return monaco.MarkerSeverity.Info;
    case EDiagnosticSeverity.Hint:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

function toMarker(monaco: Monaco, d: IDiagnostic) {
  return {
    severity: toMarkerSeverity(monaco, d.severity),
    message: d.message,
    source: d.source,
    code: d.code,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  };
}

export function attachRiscvDiagnostics(editor: TEditor, monaco: Monaco) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const validate = () => {
    const model = editor.getModel();
    if (!model) return;

    const markers = getDiagnostics(model.getValue()).map((d) => toMarker(monaco, d));
    monaco.editor.setModelMarkers(model, DIAGNOSTIC_SOURCE, markers);
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(validate, DIAGNOSTICS_DELAY_MS);
  };

  validate();

  const contentSubscription = editor.onDidChangeModelContent(schedule);
  const modelSubscription = editor.onDidChangeModel(validate);

  return {
    dispose() {
      clearTimeout(timer);
      contentSubscription.dispose();
      modelSubscription.dispose();
    },
  };
}
