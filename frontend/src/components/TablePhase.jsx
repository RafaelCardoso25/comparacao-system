import React, { useState, useMemo } from 'react';
import { exportTableToExcel, formatCurrency } from '../utils/export.js';
import ConfirmModal from './ConfirmModal.jsx';

function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let str = String(value).trim().replace(/[R$\s]/g, '');
  const hasComma = str.includes(',');
  const hasDot = str.includes('.');
  if (hasComma && hasDot) {
    str = str.lastIndexOf(',') > str.lastIndexOf('.')
      ? str.replace(/\./g, '').replace(',', '.')
      : str.replace(/,/g, '');
  } else if (hasComma) {
    str = str.replace(/\./g, '').replace(',', '.');
  }
  const num = Number(str);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function buildPricesFromSources(sources = []) {
  const prices = {};
  sources.forEach(source => {
    const current = prices[source.cotacaoIdx];
    const price = parsePrice(source?.totalPrice ?? source?.price);
    if (price && (current === undefined || price < current)) {
      prices[source.cotacaoIdx] = price;
    }
  });
  return prices;
}

function buildQtysFromSources(sources = []) {
  const qtys = {};
  sources.forEach(source => {
    const idx = Number(source?.cotacaoIdx);
    if (!Number.isInteger(idx)) return;
    if (qtys[idx] === undefined) qtys[idx] = parsePrice(source?.qty) || 1;
  });
  return qtys;
}

function buildOriginalNamesFromSources(sources = []) {
  return [...new Set(sources.map(s => s.name).filter(Boolean))];
}

function pickCanonicalName(row, sources = []) {
  const originalNames = buildOriginalNamesFromSources(sources);
  if (originalNames.length === 0) return row.item || 'Novo Produto';
  if (originalNames.includes(row.item)) return row.item;
  return originalNames.sort((a, b) => b.length - a.length)[0];
}

// ─── Modal de Match Manual ────────────────────────────────────────────────────
function LinkModal({ sourceRow, tableRows, onConfirm, onCancel }) {
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');

  const candidates = tableRows.filter(r => r.id !== sourceRow.id);
  const filtered = candidates.filter(r =>
    r.item.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .includes(search.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
  );

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Vincular Produto</h3>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <p className="modal-description">
          Selecione o produto que deve ser considerado o mesmo que:
        </p>
        <div className="modal-source-name">"{sourceRow.item}"</div>

        <div className="search-wrapper" style={{ margin: '12px 0' }}>
          <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="search-input"
            autoFocus
            type="text"
            placeholder="Buscar produto..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')}>✕</button>
          )}
        </div>

        <div className="modal-list">
          {filtered.length === 0 ? (
            <p className="modal-empty">Nenhum produto encontrado.</p>
          ) : (
            filtered.map(row => (
              <button
                key={row.id}
                className={`modal-item ${selectedId === row.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(row.id)}
              >
                <span className="modal-item-name">{row.item}</span>
                {row.originalNames?.length > 1 && (
                  <span className="modal-item-variants">
                    {row.originalNames.join(' · ')}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancelar</button>
          <button
            className="btn btn-primary"
            disabled={!selectedId}
            onClick={() => selectedId && onConfirm(sourceRow.id, selectedId)}
          >
            Vincular
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal de Separar Item ────────────────────────────────────────────────────
function SplitModal({ nameToSplit, parentRow, tableRows, onConfirmSplit, onCancel }) {
  const [mode, setMode] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');

  const candidates = tableRows.filter(r => r.id !== parentRow.id);
  const filtered = candidates.filter(r =>
    r.item.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .includes(search.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
  );

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Separar Item</h3>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <p className="modal-description">Separando o item:</p>
        <div className="modal-source-name">"{nameToSplit}"</div>

        {!mode && (
          <div className="split-mode-options">
            <button className="split-mode-btn" onClick={() => setMode('exclusive')}>
              <span className="split-mode-icon">📋</span>
              <span>
                <span className="split-mode-label">Produto exclusivo</span>
                <span className="split-mode-desc">Vira uma linha nova independente na tabela</span>
              </span>
            </button>
            <button className="split-mode-btn" onClick={() => setMode('link')}>
              <span className="split-mode-icon">🔗</span>
              <span>
                <span className="split-mode-label">Juntar com outro produto</span>
                <span className="split-mode-desc">Selecione com qual produto ele deve ser agrupado</span>
              </span>
            </button>
          </div>
        )}

        {mode === 'exclusive' && (
          <div className="split-confirm">
            <p className="split-confirm-text">
              O item <strong>"{nameToSplit}"</strong> será separado e virará uma nova linha na tabela.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setMode(null)}>← Voltar</button>
              <button className="btn btn-primary" onClick={() => onConfirmSplit(nameToSplit, null)}>
                Confirmar
              </button>
            </div>
          </div>
        )}

        {mode === 'link' && (
          <>
            <div className="search-wrapper" style={{ margin: '12px 0' }}>
              <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                className="search-input"
                autoFocus
                type="text"
                placeholder="Buscar produto..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="modal-list">
              {filtered.length === 0 ? (
                <p className="modal-empty">Nenhum produto encontrado.</p>
              ) : (
                filtered.map(row => (
                  <button
                    key={row.id}
                    className={`modal-item ${selectedId === row.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <span className="modal-item-name">{row.item}</span>
                    {row.originalNames?.length > 1 && (
                      <span className="modal-item-variants">
                        {row.originalNames.join(' · ')}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setMode(null)}>← Voltar</button>
              <button
                className="btn btn-primary"
                disabled={!selectedId}
                onClick={() => selectedId && onConfirmSplit(nameToSplit, selectedId)}
              >
                Juntar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Tooltip de nomes originais ───────────────────────────────────────────────
function OriginalNamesTooltip({ row, reason, onRequestSplit }) {
  const [show, setShow] = useState(false);
  const names = row.originalNames;
  if (!names || names.length <= 1) return null;

  return (
    <span
      className="original-names-badge"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span className="original-names-badge-number">{names.length}</span>
      {show && (
        <div className="original-names-tooltip">
          <strong>Nomes agrupados:</strong>
          {names.map((n, i) => (
            <div key={i} className="tooltip-name-row">
              <span className="tooltip-name-text">• {n}</span>
              <button
                className="tooltip-split-btn"
                title="Separar este item do grupo"
                onMouseDown={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShow(false);
                  onRequestSplit(row, n);
                }}
              >
                ✂ separar
              </button>
            </div>
          ))}
          {reason && reason !== 'produto único' && (
            <div className="tooltip-reason">💡 {reason}</div>
          )}
        </div>
      )}
    </span>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
export default function TablePhase({
  tableRows, setTableRows,
  cotacoes, setCotacoes,
  onCompare, onBack, loadingRows
}) {
  const [editingCell, setEditingCell] = useState(null);
  const [linkingRow, setLinkingRow] = useState(null);
  const [search, setSearch] = useState('');
  const [editingCotacaoName, setEditingCotacaoName] = useState(null);
  const [splitRequest, setSplitRequest] = useState(null);

  const filteredRows = useMemo(() => {
    if (!search.trim()) return tableRows;
    const q = search.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return tableRows.filter(row =>
      row.item.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(q)
    );
  }, [tableRows, search]);

  // ─── Edição de célula ───────────────────────────────────────────────────────
  function handleCellChange(rowId, field, value) {
    setTableRows(prev => prev.map(row => {
      if (row.id !== rowId) return row;
  
      if (field === 'item') {
        return { ...row, item: value };
      }
  
      if (typeof field === 'string' && field.startsWith('qty_')) {
        const idx = Number(field.replace('qty_', ''));
        const newQty = parseFloat(value) || 1;
        const oldQty = parsePrice(row.qtys?.[idx]) || 1;
        const oldTotal = parsePrice(row.prices?.[idx]);
  
        let newTotal = oldTotal;
        if (oldTotal && oldQty > 0) {
          const unitPrice = oldTotal / oldQty;
          newTotal = roundMoney(unitPrice * newQty);
        }
  
        // FIX: atualiza sources para que compareItems use o valor correto
        const updatedSources = (row.sources || []).map(source => {
          if (Number(source.cotacaoIdx) !== idx) return source;
          const sourceTotal = parsePrice(source.totalPrice ?? source.price);
          const sourceOldQty = parsePrice(source.qty) || 1;
          if (!sourceTotal || sourceOldQty <= 0) return { ...source, qty: newQty };
          const unitP = sourceTotal / sourceOldQty;
          return {
            ...source,
            qty: newQty,
            totalPrice: roundMoney(unitP * newQty)
          };
        });
  
        return {
          ...row,
          qtys: { ...row.qtys, [idx]: newQty },
          prices: { ...row.prices, [idx]: newTotal ?? oldTotal },
          sources: updatedSources
        };
      }
  
      // Edição de preço total diretamente — atualiza sources também
      const idx = Number(field);
      const newPrice = parseFloat(value);
      const updatedSources = (row.sources || []).map(source => {
        if (Number(source.cotacaoIdx) !== idx) return source;
        return {
          ...source,
          totalPrice: Number.isFinite(newPrice) ? newPrice : source.totalPrice
        };
      });
  
      return {
        ...row,
        prices: { ...row.prices, [field]: value },
        sources: updatedSources
      };
    }));
  }

  function handleCotacaoNameChange(idx, value) {
    setCotacoes(prev => prev.map((c, i) => i === idx ? { ...c, cotacaoName: value } : c));
    setTableRows(prev => prev.map(row => ({
      ...row,
      sources: (row.sources || []).map(source =>
        source.cotacaoIdx === idx ? { ...source, cotacaoName: value } : source
      )
    })));
  }

  function addRow() {
    setTableRows(prev => [
      ...prev,
      {
        id: crypto.randomUUID(),
        item: 'Novo Produto',
        prices: {},
        qtys: {},
        sources: [],
        originalNames: []
      }
    ]);
  }

  function removeRow(rowId) {
    setTableRows(prev => prev.filter(r => r.id !== rowId));
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === 'Escape') setEditingCell(null);
  }

  const isEditing = (rowId, field) =>
    editingCell?.rowId === rowId && editingCell?.field === field;

  function handleLinkConfirm(sourceId, targetId) {
    setTableRows(prev => {
      const source = prev.find(r => r.id === sourceId);
      const target = prev.find(r => r.id === targetId);
      if (!source || !target) return prev;
      const mergedSources = [...(target.sources || []), ...(source.sources || [])];
      const mergedPrices = buildPricesFromSources(mergedSources);
      const mergedQtys = buildQtysFromSources(mergedSources);
      const mergedNames = buildOriginalNamesFromSources(mergedSources);
      return prev
        .filter(r => r.id !== sourceId)
        .map(r => r.id === targetId
          ? {
              ...target,
              sources: mergedSources,
              prices: mergedPrices,
              qtys: mergedQtys,
              originalNames: mergedNames,
              item: pickCanonicalName(target, mergedSources),
              groupReason: 'agrupado manualmente'
            }
          : r
        );
    });
    setLinkingRow(null);
  }

  function handleRequestSplit(row, nameToSplit) {
    setSplitRequest({ row, nameToSplit });
  }

  function handleConfirmSplit(nameToSplit, targetId) {
    const { row: parentRow } = splitRequest;
    setTableRows(prev => {
      const currentParent = prev.find(r => r.id === parentRow.id);
      if (!currentParent) return prev;
      const sourcesToMove = (currentParent.sources || []).filter(s => s.name === nameToSplit);
      const remainingSources = (currentParent.sources || []).filter(s => s.name !== nameToSplit);
      if (sourcesToMove.length === 0) return prev;

      let updatedRows = prev.map(r => {
        if (r.id !== currentParent.id) return r;
        if (remainingSources.length === 0) return null;
        return {
          ...r,
          sources: remainingSources,
          prices: buildPricesFromSources(remainingSources),
          qtys: buildQtysFromSources(remainingSources),
          originalNames: buildOriginalNamesFromSources(remainingSources),
          item: pickCanonicalName(r, remainingSources)
        };
      }).filter(Boolean);

      if (targetId) {
        updatedRows = updatedRows.map(r => {
          if (r.id !== targetId) return r;
          const mergedSources = [...(r.sources || []), ...sourcesToMove];
          return {
            ...r,
            sources: mergedSources,
            prices: buildPricesFromSources(mergedSources),
            qtys: buildQtysFromSources(mergedSources),
            originalNames: buildOriginalNamesFromSources(mergedSources),
            item: pickCanonicalName(r, mergedSources),
            groupReason: 'ajustado manualmente'
          };
        });
      } else {
        updatedRows.push({
          id: crypto.randomUUID(),
          item: nameToSplit,
          prices: buildPricesFromSources(sourcesToMove),
          qtys: buildQtysFromSources(sourcesToMove),
          sources: sourcesToMove,
          originalNames: buildOriginalNamesFromSources(sourcesToMove),
          groupReason: 'separado manualmente'
        });
      }

      return updatedRows;
    });
    setSplitRequest(null);
  }

  return (
    <div className="table-phase">
      {linkingRow && (
        <LinkModal
          sourceRow={linkingRow}
          tableRows={tableRows}
          onConfirm={handleLinkConfirm}
          onCancel={() => setLinkingRow(null)}
        />
      )}

      {splitRequest && (
        <SplitModal
          nameToSplit={splitRequest.nameToSplit}
          parentRow={splitRequest.row}
          tableRows={tableRows}
          onConfirmSplit={handleConfirmSplit}
          onCancel={() => setSplitRequest(null)}
        />
      )}

      <div className="phase-header">
        <span className="phase-tag">ETAPA 2</span>
        <h2>Revise os Dados Extraídos</h2>
        <p>
          Clique em qualquer célula para editar. Use <kbd>Enter</kbd> para confirmar.
          A <strong>quantidade</strong> pode ser editada por cotação — o valor total será recalculado automaticamente.
        </p>
      </div>

      {loadingRows && (
        <div className="loading-grouping">
          <div className="loading-spinner" />
          <span>Agrupando produtos similares com IA...</span>
        </div>
      )}

      <div
        className="table-toolbar"
        style={{ opacity: loadingRows ? 0.5 : 1, pointerEvents: loadingRows ? 'none' : 'auto' }}
      >
        <button className="btn btn-ghost" onClick={onBack}>← Voltar</button>
        <div className="toolbar-right">
          <div className="search-wrapper">
            <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="search-input"
              type="text"
              placeholder="Buscar produto..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="search-clear" onClick={() => setSearch('')}>✕</button>
            )}
          </div>

          <button className="btn btn-ghost" onClick={addRow} disabled={loadingRows}>
            + Linha
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => exportTableToExcel(tableRows, cotacoes)}
            disabled={loadingRows}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Excel
          </button>

          <button className="btn btn-primary" onClick={onCompare} disabled={loadingRows}>
            Comparar →
          </button>
        </div>
      </div>

      {search && (
        <div className="search-results-info">
          {filteredRows.length} produto(s) encontrado(s) para "{search}"
        </div>
      )}

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-produto">Produto</th>
              {cotacoes.map((c, i) => (
                <th key={i} className="col-cotacao">
                  <div className="cotacao-header">
                    <span className="cotacao-badge">{i + 1}</span>
                    {editingCotacaoName === i ? (
                      <input
                        autoFocus
                        className="cotacao-name-input"
                        value={c.cotacaoName}
                        onChange={e => handleCotacaoNameChange(i, e.target.value)}
                        onBlur={() => setEditingCotacaoName(null)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === 'Escape') setEditingCotacaoName(null);
                        }}
                        maxLength={40}
                      />
                    ) : (
                      <span
                        className="cotacao-name-editable"
                        onClick={() => setEditingCotacaoName(i)}
                        title="Clique para renomear o fornecedor"
                      >
                        {c.cotacaoName}
                        <span className="edit-hint">✎</span>
                      </span>
                    )}
                  </div>
                  <div className="cotacao-filename">{c.originalName}</div>
                </th>
              ))}
              <th className="col-actions" />
            </tr>
          </thead>

          <tbody>
            {filteredRows.map(row => (
              <tr key={row.id}>
                {/* Coluna do produto */}
                <td
                  className={`cell-produto ${isEditing(row.id, 'item') ? 'editing' : ''}`}
                  onClick={() => !loadingRows && setEditingCell({ rowId: row.id, field: 'item' })}
                >
                  {isEditing(row.id, 'item') ? (
                    <input
                      autoFocus
                      className="cell-input"
                      value={row.item}
                      onChange={e => handleCellChange(row.id, 'item', e.target.value)}
                      onBlur={() => setEditingCell(null)}
                      onKeyDown={handleKeyDown}
                    />
                  ) : (
                    <span className="cell-text-wrapper">
                      <span className="cell-text">{row.item || '—'}</span>
                      <OriginalNamesTooltip
                        row={row}
                        reason={row.groupReason}
                        onRequestSplit={handleRequestSplit}
                      />
                    </span>
                  )}
                </td>

                {/* Colunas por cotação: qty editável + preço total */}
                {cotacoes.map((_, idx) => {
                  const rawPrice = row.prices?.[idx];
                  const rawQty = row.qtys?.[idx];
                  const price = parsePrice(rawPrice);
                  const qty = parsePrice(rawQty) || 1;
                  const hasValue = price && price > 0;

                  const qtyField = `qty_${idx}`;

                  return (
                    <td
                      key={idx}
                      className={`cell-price ${hasValue ? 'has-value' : 'no-value'}`}
                    >
                      {hasValue ? (
                        <div className="cell-price-with-qty">
                          {/* Qty editável */}
                          <span className="cell-qty-wrapper">
                            {isEditing(row.id, qtyField) ? (
                              <input
                                autoFocus
                                className="cell-input cell-input-qty"
                                type="number"
                                step="1"
                                min="1"
                                value={qty}
                                onChange={e => handleCellChange(row.id, qtyField, e.target.value)}
                                onBlur={() => setEditingCell(null)}
                                onKeyDown={handleKeyDown}
                              />
                            ) : (
                              <span
                                className="cell-qty"
                                onClick={() => !loadingRows && setEditingCell({ rowId: row.id, field: qtyField })}
                                title="Clique para editar a quantidade"
                              >
                                {qty}×
                              </span>
                            )}
                          </span>

                          {/* Preço total editável */}
                          <span
                            className="cell-text"
                            onClick={() => !loadingRows && setEditingCell({ rowId: row.id, field: idx })}
                            title="Clique para editar o valor total"
                          >
                            {isEditing(row.id, idx) ? (
                              <input
                                autoFocus
                                className="cell-input cell-input-price"
                                type="number"
                                step="0.01"
                                min="0"
                                value={rawPrice ?? ''}
                                onChange={e => handleCellChange(row.id, idx, e.target.value)}
                                onBlur={() => setEditingCell(null)}
                                onKeyDown={handleKeyDown}
                                placeholder="0,00"
                              />
                            ) : (
                              formatCurrency(price)
                            )}
                          </span>
                        </div>
                      ) : (
                        <span className="empty-dash">—</span>
                      )}
                    </td>
                  );
                })}

                <td className="col-actions">
                  <button
                    className="btn-link-row"
                    onClick={() => !loadingRows && setLinkingRow(row)}
                    title="Vincular com outro produto"
                    disabled={loadingRows}
                  >
                    ⇄
                  </button>
                  <button
                    className="btn-remove-row"
                    onClick={() => removeRow(row.id)}
                    title="Remover produto"
                    disabled={loadingRows}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loadingRows && filteredRows.length === 0 && (
          <div className="table-empty">
            {search
              ? `Nenhum produto encontrado para "${search}".`
              : 'Nenhum produto. Clique em "+ Linha" para inserir manualmente.'}
          </div>
        )}
      </div>

      <div className="table-footer">
        <span className="row-count">
          {loadingRows ? 'Agrupando...' : `${tableRows.length} produto(s)`}
          {search && ` · ${filteredRows.length} visível(is)`}
        </span>
        <button
          className="btn btn-primary btn-large"
          onClick={onCompare}
          disabled={loadingRows}
          style={{ width: 'auto', marginTop: 0 }}
        >
          Confirmar e Comparar →
        </button>
      </div>
    </div>
  );
}