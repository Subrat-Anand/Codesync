// Binds a Y.Text to a Monaco text model and renders remote cursors/selections
// from awareness. Written against the `monaco` instance handed out by
// @monaco-editor/react (so we never import the monaco-editor package into the
// Next.js bundle).
import * as Y from 'yjs';

const STYLE_ID = 'codesync-remote-cursors';

const cssString = (value) => JSON.stringify(String(value)).replace(/[\u2028\u2029]/g, '');

export class MonacoBinding {
  /**
   * @param {{monaco: any, ytext: Y.Text, editor: any, awareness: any}} opts
   */
  constructor({ monaco, ytext, editor, awareness }) {
    this.monaco = monaco;
    this.ytext = ytext;
    this.editor = editor;
    this.model = editor.getModel();
    this.awareness = awareness;
    this.applyingRemote = false;
    this.decorations = editor.createDecorationsCollection([]);
    this.destroyed = false;
    this.canPublish = false; // set by the editor from the server-confirmed permission

    // Y.Text always uses "\n"; make Monaco agree so offsets line up 1:1.
    this.model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const initial = ytext.toString();
    if (this.model.getValue() !== initial) this.model.setValue(initial);

    // Y -> Monaco
    this.yObserver = (event, transaction) => {
      if (transaction.origin === this) return;
      this.applyingRemote = true;
      try {
        let index = 0;
        for (const op of event.delta) {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (op.insert !== undefined) {
            const text = typeof op.insert === 'string' ? op.insert : '';
            const pos = this.model.getPositionAt(index);
            this.model.applyEdits([{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text, forceMoveMarkers: true }]);
            index += text.length;
          } else if (op.delete !== undefined) {
            const from = this.model.getPositionAt(index);
            const to = this.model.getPositionAt(index + op.delete);
            this.model.applyEdits([{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: '' }]);
          }
        }
      } finally {
        this.applyingRemote = false;
      }
      this.renderRemoteCursors();
    };
    ytext.observe(this.yObserver);

    // Monaco -> Y
    this.contentSub = this.model.onDidChangeContent((event) => {
      if (this.applyingRemote) return;
      ytext.doc.transact(() => {
        // Apply from the end so earlier offsets stay valid.
        const changes = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
        for (const change of changes) {
          if (change.rangeLength > 0) ytext.delete(change.rangeOffset, change.rangeLength);
          if (change.text) ytext.insert(change.rangeOffset, change.text);
        }
      }, this);
      if (this.canPublish) this.awareness.setLocalStateField('typing', Date.now());
    });

    // Local cursor -> awareness
    this.selectionSub = editor.onDidChangeCursorSelection(() => this.publishCursor());
    this.awarenessHandler = () => this.renderRemoteCursors();
    awareness.on('change', this.awarenessHandler);

    this.styleEl = document.getElementById(STYLE_ID) || Object.assign(document.createElement('style'), { id: STYLE_ID });
    if (!this.styleEl.isConnected) document.head.appendChild(this.styleEl);

    this.renderRemoteCursors();
  }

  /** Only people who can edit show a cursor to others (the server enforces this too). */
  setCanPublish(value) {
    this.canPublish = !!value;
    if (this.canPublish) this.publishCursor();
    else {
      this.awareness.setLocalStateField('cursor', null);
      this.awareness.setLocalStateField('typing', null);
    }
  }

  publishCursor() {
    if (this.destroyed || !this.canPublish) return;
    const selection = this.editor.getSelection();
    if (!selection) return;
    const anchor = this.model.getOffsetAt({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn });
    const head = this.model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn });
    this.awareness.setLocalStateField('cursor', {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, anchor)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, head)),
    });
  }

  renderRemoteCursors() {
    if (this.destroyed) return;
    const doc = this.ytext.doc;
    const decorations = [];
    const rules = [];
    const { Range } = this.monaco;

    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === doc.clientID || !state?.cursor || !state.user) return;
      let anchorIdx;
      let headIdx;
      try {
        anchorIdx = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), doc);
        headIdx = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), doc);
      } catch {
        return;
      }
      if (!anchorIdx || !headIdx || anchorIdx.type !== this.ytext || headIdx.type !== this.ytext) return;

      const a = this.model.getPositionAt(anchorIdx.index);
      const h = this.model.getPositionAt(headIdx.index);
      const color = /^#[0-9a-fA-F]{6}$/.test(state.user.color) ? state.user.color : '#888888';
      const id = `c${clientId}`;
      rules.push(
        `.rc-${id}{position:absolute;height:100%;box-sizing:border-box;border-left:2px solid ${color};pointer-events:none;}`,
        `.rc-${id}::after{content:${cssString(state.user.name)};position:absolute;bottom:100%;left:-2px;padding:0 5px;border-radius:3px 3px 3px 0;background:${color};color:#fff;font:600 10px/1.4 system-ui,sans-serif;white-space:nowrap;pointer-events:none;z-index:5;}`,
        `.rs-${id}{background:${color}40;}`,
      );

      if (anchorIdx.index !== headIdx.index) {
        decorations.push({
          range: new Range(a.lineNumber, a.column, h.lineNumber, h.column),
          options: { className: `rs-${id}`, stickiness: 1 },
        });
      }
      decorations.push({
        range: new Range(h.lineNumber, h.column, h.lineNumber, h.column),
        options: { afterContentClassName: `rc-${id}`, stickiness: 1, zIndex: 10 },
      });
    });

    this.styleEl.textContent = rules.join('\n');
    this.decorations.set(decorations);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ytext.unobserve(this.yObserver);
    this.contentSub.dispose();
    this.selectionSub.dispose();
    this.awareness.off('change', this.awarenessHandler);
    this.awareness.setLocalStateField('cursor', null);
    this.decorations.clear();
    if (this.styleEl) this.styleEl.textContent = '';
  }
}
