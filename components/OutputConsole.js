'use client';

import { useState } from 'react';

function Result({ run }) {
  const { result } = run;
  if (run.running) {
    return <p className="console-muted"><span className="spinner" /> {run.by ? `${run.by} is running ${run.language}…` : 'Running…'}</p>;
  }
  if (!result) return <p className="console-muted">Run the code to see output here. Everyone in the room sees the results.</p>;

  if (result.stage === 'internal') return <pre className="out err">{result.error}</pre>;
  if (result.stage === 'compile') {
    return (
      <>
        <div className="out-title err">Compilation error</div>
        <pre className="out err">{result.compileOutput}</pre>
        <Footer run={run} />
      </>
    );
  }
  return (
    <>
      {result.limitExceeded && (
        <div className="out-title err">Stopped: time or memory limit exceeded ({result.signal})</div>
      )}
      {result.stdout && <pre className="out">{result.stdout}</pre>}
      {result.stderr && (
        <>
          <div className="out-title err">{result.exitCode ? 'Runtime error' : 'stderr'}</div>
          <pre className="out err">{result.stderr}</pre>
        </>
      )}
      {!result.stdout && !result.stderr && !result.limitExceeded && <p className="console-muted">(no output)</p>}
      <Footer run={run} />
    </>
  );
}

function Footer({ run }) {
  const { result } = run;
  return (
    <div className="console-footer">
      {result.exitCode !== undefined && result.exitCode !== null && <span>Exit code {result.exitCode}</span>}
      <span>{result.timeMs} ms</span>
      {run.by && <span>Run by {run.by} ({run.language})</span>}
    </div>
  );
}

export default function OutputConsole({ run, stdin, setStdin, canRun }) {
  const [tab, setTab] = useState('output');
  return (
    <section className="console">
      <div className="console-tabs">
        <button className={tab === 'output' ? 'active' : ''} onClick={() => setTab('output')}>Output</button>
        <button className={tab === 'input' ? 'active' : ''} onClick={() => setTab('input')}>Standard input</button>
      </div>
      <div className="console-body">
        {tab === 'output' ? (
          <Result run={run} />
        ) : (
          <textarea
            className="stdin"
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            disabled={!canRun}
            maxLength={16384}
            placeholder={canRun ? 'Text here is sent to your program’s standard input when you press Run' : 'Only people who can edit can run code'}
            spellCheck={false}
          />
        )}
      </div>
    </section>
  );
}
