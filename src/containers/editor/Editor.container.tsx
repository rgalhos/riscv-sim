import { editorOptions, handleEditorWillMount } from "@/config/editor/editor.config";
import { attachRiscvDiagnostics } from "@/config/editor/languages/riscv-diagnostics.config";
import { useEditor } from "@/lib/contexts/editor.context";
import { debounce } from "@/lib/utils";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { memo, useEffect, useRef } from "react";

const EDITOR_DRAFT_STORAGE_KEY = "editor_contents";

// @todo
const DEFAULT_PROGRAM = `# Print fibonacci sequence in the terminal, stopping right before overflow (2971215073)
# Author: rgmg [at] ic.ufal.br

.text

.equ val a0
.equ t1 s0
.equ t2 s1
.equ max_val s2

addi a7, zero, SYSCALL_PRINT_UINT # load print syscall

lui max_val, %hi(2971215073) # load top bits of const in s2
addi max_val, max_val, %lo(2971215073) # load bottom bits of const in s2

# print 0
addi val, zero, 0 # val = 0
ecall # print

# print 1
addi val, zero, 1 # val = 1
ecall # print

addi t1, zero, 0 # t1 = 0
addi t2, zero, 1 # t2 = 1

fib:
    add val, t1, t2 # val = t1 + t2
    ecall # print

    beq max_val, val, end #  if (max_val == val) goto end

    add t1, zero, t2 # t1 = t2
    add t2, zero, val # t2 = val
    jal zero, fib # goto fib

end:
`;

function MemoEditorContainer(props: { handleEditorChange?: () => void }) {
  const { setEditor, setMonaco } = useEditor();
  const diagnosticsRef = useRef<ReturnType<typeof attachRiscvDiagnostics> | null>(null);

  useEffect(() => {
    return () => {
      diagnosticsRef.current?.dispose();
      diagnosticsRef.current = null;
    };
  }, []);

  const saveEditorContents = (content: string) => {
    localStorage.setItem(EDITOR_DRAFT_STORAGE_KEY, content);
  };

  const saveEditorContentsDebounced = debounce(saveEditorContents, 500);

  const handleEditorDidMount: EditorProps["onMount"] = (editor, monaco) => {
    setEditor(editor);
    setMonaco(monaco);

    const draft = localStorage.getItem(EDITOR_DRAFT_STORAGE_KEY);
    editor.setValue(draft ?? DEFAULT_PROGRAM);

    diagnosticsRef.current?.dispose();
    diagnosticsRef.current = attachRiscvDiagnostics(editor, monaco);
  };

  const handleEditorChange: EditorProps["onChange"] = (value, editor) => {
    void editor;

    saveEditorContentsDebounced(value ?? "");

    props?.handleEditorChange?.();
  };

  return (
    <div className="min-h-0 flex-1">
      <Editor
        width="100%"
        height="100%"
        language="riscv"
        theme="rvsim-dark"
        options={editorOptions}
        beforeMount={handleEditorWillMount}
        onMount={handleEditorDidMount}
        onChange={handleEditorChange}
      />
    </div>
  );
}

export const EditorContainer = memo(MemoEditorContainer);
