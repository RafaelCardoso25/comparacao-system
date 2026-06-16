import React, { useState } from 'react';

export default function HistoryPanel({
  history,
  onLoad,
  onDelete,
  onClearAll,
  floating = false
}) {
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);

  if (history.length === 0) return null;

  function formatDate(iso) {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function handleClearAll() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    onClearAll();
    setConfirmClear(false);
    setOpen(false);
  }

  function handleCancelClear() {
    setConfirmClear(false);
  }

  return (
    <div className={`history-panel ${floating ? 'history-panel--floating' : ''}`}>
      <button
        className="history-toggle"
        onClick={() => { setOpen(o => !o); setConfirmClear(false); }}
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        Cotações anteriores ({history.length})
        <span className={`history-chevron ${open ? 'open' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="history-body">
          {/* Aviso sobre histórico local */}
          <div className="history-local-warning">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>
              Histórico salvo localmente no servidor. Será perdido se o servidor
              for reiniciado ou o arquivo <code>history.json</code> deletado.
            </span>
          </div>

          {/* Botão limpar tudo */}
          <div className="history-clear-bar">
            {!confirmClear ? (
              <button
                className="btn-clear-history"
                onClick={handleClearAll}
                title="Apagar todo o histórico"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                Limpar histórico
              </button>
            ) : (
              <div className="history-confirm-clear">
                <span>Apagar tudo?</span>
                <button
                  className="btn-confirm-clear"
                  onClick={handleClearAll}
                >
                  Sim, apagar
                </button>
                <button
                  className="btn-cancel-clear"
                  onClick={handleCancelClear}
                >
                  Cancelar
                </button>
              </div>
            )}
          </div>

          <div className="history-list">
            {history.map(entry => (
              <div
                key={entry.id}
                className="history-entry"
                onMouseEnter={() => setHoveredId(entry.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="history-entry-info">
                  <span className="history-entry-date">
                    {formatDate(entry.savedAt)}
                  </span>
                  <span className="history-entry-files">
                    {entry.cotacoes?.map(c => c.cotacaoName).join(' · ')}
                  </span>
                  <div className="history-entry-meta">
                    <span className="history-entry-count">
                      {entry.tableRows?.length ?? 0} produtos
                    </span>
                    {entry.comparisonResult && (
                      <span className="history-has-result">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        resultado salvo
                      </span>
                    )}
                  </div>
                </div>

                <div className="history-entry-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => onLoad(entry)}
                    title="Carregar esta comparação"
                  >
                    Carregar
                  </button>

                  {/* X individual — aparece só ao passar o mouse */}
                  <button
                    className="btn-delete-entry"
                    onClick={() => onDelete(entry.id)}
                    title="Remover este item do histórico"
                    style={{
                      opacity: hoveredId === entry.id ? 1 : 0,
                      pointerEvents: hoveredId === entry.id ? 'auto' : 'none',
                      transition: 'opacity 0.15s ease'
                    }}
                    aria-label="Remover"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}