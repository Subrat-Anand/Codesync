'use client';

import { useEffect, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { MonacoBinding } from '../lib/monacoBinding';

// Monaco is served from our own origin (copied to /public by `npm install`),
// so the editor works without a CDN.
loader.config({ paths: { vs: '/monaco/vs' } });

function defineTheme(monaco) {
  monaco.editor.defineTheme('codesync-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0d1117',
      'editorGutter.background': '#0d1117',
      'editor.lineHighlightBackground': '#161b2280',
      'editorLineNumber.foreground': '#4b5563',
      'editorLineNumber.activeForeground': '#9ca3af',
    },
  });
}

export default function EditorPane({ collab, canEdit, language }) {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const bindingRef = useRef(null);

  const handleMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    bindingRef.current = new MonacoBinding({
      monaco,
      editor,
      ytext: collab.doc.getText('code'),
      awareness: collab.awareness,
    });
    bindingRef.current.setCanPublish(canEdit);
  };

  useEffect(
    () => () => {
      bindingRef.current?.destroy();
      bindingRef.current = null;
    },
    [],
  );

  // Permission changes apply instantly, without remounting the editor.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !canEdit });
    bindingRef.current?.setCanPublish(canEdit);
  }, [canEdit]);

  // Language is shared room state.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && monacoRef.current) monacoRef.current.editor.setModelLanguage(model, language);
  }, [language]);

  return (
    <Editor
      height="100%"
      theme="codesync-dark"
      defaultLanguage={language}
      defaultValue=""
      beforeMount={defineTheme}
      onMount={handleMount}
      loading={<div className="editor-loading">Loading editor…</div>}
      options={{
        readOnly: !canEdit,
        minimap: { enabled: false },
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, Menlo, Consolas, monospace",
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
        smoothScrolling: true,
        padding: { top: 14 },
        renderLineHighlight: 'line',
        fixedOverflowWidgets: true,
      }}
    />
  );
}
