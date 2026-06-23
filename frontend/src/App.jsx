import React, { useState, useEffect } from 'react';
import UploadPhase from './components/UploadPhase.jsx';
import TablePhase from './components/TablePhase.jsx';
import ComparisonResult from './components/ComparisonResult.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import { buildTableRows, buildTableRowsSync } from './utils/normalize.js';
import { compareItems } from './utils/compare.js';

const PHASE = { UPLOAD: 'upload', TABLE: 'table', RESULT: 'result' };

export default function App() {
  const [phase, setPhase] = useState(PHASE.UPLOAD);
  const [cotacoes, setCotacoes] = useState([]);
  const [tableRows, setTableRows] = useState([]);
  const [comparisonResult, setComparisonResult] = useState(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [history, setHistory] = useState([]);
  const [companyName, setCompanyName] = useState(() =>
    localStorage.getItem('companyName') || ''
  );

  useEffect(() => {
    fetchHistory();
  }, []);

  async function fetchHistory() {
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/history`);
      const data = await res.json();
      if (data.success) setHistory(data.history ?? []);
    } catch {
      /* histórico indisponível */
    }
  }

  async function saveToHistory(cotacoesData, rows, result) {
    try {
      await fetch(`${import.meta.env.VITE_API_URL}/api/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entry: {
            cotacoes: cotacoesData,
            tableRows: rows,
            comparisonResult: result
          }
        })
      });
      fetchHistory();
    } catch {
      /* falha silenciosa */
    }
  }

  async function handleDeleteHistory(id) {
    try {
      await fetch(`${import.meta.env.VITE_API_URL}/api/history/${id}`, { method: 'DELETE' });
    } catch {
      /* ignora */
    }
    setHistory(prev => prev.filter(h => h.id !== id));
  }

  async function handleClearAll() {
    try {
      await fetch(`${import.meta.env.VITE_API_URL}/api/history`, { method: 'DELETE' });
    } catch {
      /* ignora */
    }
    setHistory([]);
  }

  function handleLoadHistory(entry) {
    setCotacoes(entry.cotacoes ?? []);
    setTableRows(entry.tableRows ?? []);
    setComparisonResult(entry.comparisonResult ?? null);
    setPhase(entry.comparisonResult ? PHASE.RESULT : PHASE.TABLE);
  }

  async function handleExtracted(data, cotacoesData) {
    setCotacoes(cotacoesData);
    setLoadingRows(true);
    setPhase(PHASE.TABLE);

    let rows;
    try {
      rows = await buildTableRows(data);
      setTableRows(rows);
    } catch (err) {
      console.error('Agrupamento inteligente falhou, usando modo simples:', err);
      rows = buildTableRowsSync(data);
      setTableRows(rows);
    } finally {
      setLoadingRows(false);
    }

    if (rows?.length > 0) {
      await saveToHistory(cotacoesData, rows, null);
    }
  }

  function handleCompare() {
    const result = compareItems(tableRows, cotacoes);
    setComparisonResult(result);
    setPhase(PHASE.RESULT);
    saveToHistory(cotacoes, tableRows, result);
  }

  function handleRestart() {
    setPhase(PHASE.UPLOAD);
    setCotacoes([]);
    setTableRows([]);
    setComparisonResult(null);
  }

  function handleCompanyNameChange(name) {
    setCompanyName(name);
    localStorage.setItem('companyName', name);
  }

  function handlePhaseClick(key) {
    if (key === PHASE.UPLOAD) return;

    if (key === PHASE.TABLE && (phase === PHASE.TABLE || phase === PHASE.RESULT)) {
      setPhase(PHASE.TABLE);
    }

    if (key === PHASE.RESULT && phase === PHASE.RESULT && comparisonResult) {
      setPhase(PHASE.RESULT);
    }
  }

  function isPhaseClickable(key) {
    if (key === PHASE.TABLE) return phase === PHASE.TABLE || phase === PHASE.RESULT;
    if (key === PHASE.RESULT) return phase === PHASE.RESULT && !!comparisonResult;
    return false;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">◈</span>
            <span className="logo-text">CotaCompara</span>
          </div>

          <nav className="phase-indicator">
            {[
              { key: PHASE.UPLOAD, label: '01 Upload' },
              { key: PHASE.TABLE, label: '02 Revisão' },
              { key: PHASE.RESULT, label: '03 Resultado' }
            ].map(({ key, label }) => (
              <span
                key={key}
                className={[
                  'phase-step',
                  phase === key ? 'active' : '',
                  isPhaseClickable(key) && phase !== key ? 'done clickable' : ''
                ].filter(Boolean).join(' ')}
                onClick={() => handlePhaseClick(key)}
                title={isPhaseClickable(key) && phase !== key ? `Voltar para ${label}` : ''}
              >
                {label}
              </span>
            ))}
          </nav>

          <div className="company-name-wrapper">
            <input
              className="company-name-input"
              type="text"
              placeholder="Nome da sua empresa (aparece no PDF)"
              value={companyName}
              onChange={e => handleCompanyNameChange(e.target.value)}
              maxLength={60}
            />
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container">
          {phase === PHASE.UPLOAD && (
            <>
              <UploadPhase onExtracted={handleExtracted} />
              <HistoryPanel
                history={history}
                onLoad={handleLoadHistory}
                onDelete={handleDeleteHistory}
                onClearAll={handleClearAll}
              />
            </>
          )}

          {phase === PHASE.TABLE && (
            <TablePhase
              tableRows={tableRows}
              setTableRows={setTableRows}
              cotacoes={cotacoes}
              setCotacoes={setCotacoes}
              onCompare={handleCompare}
              onBack={() => setPhase(PHASE.UPLOAD)}
              loadingRows={loadingRows}
            />
          )}

          {phase === PHASE.RESULT && comparisonResult && (
            <ComparisonResult
              result={comparisonResult}
              cotacoes={cotacoes}
              tableRows={tableRows}
              companyName={companyName}
              onBack={() => setPhase(PHASE.TABLE)}
              onRestart={handleRestart}
            />
          )}
        </div>

        {phase !== PHASE.UPLOAD && (
          <div className="history-floating">
            <HistoryPanel
              history={history}
              onLoad={handleLoadHistory}
              onDelete={handleDeleteHistory}
              onClearAll={handleClearAll}
              floating
            />
          </div>
        )}
      </main>
    </div>
  );
}