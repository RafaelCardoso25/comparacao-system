import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  formatCurrency,
  exportResultsToPDF,
  exportSingleCotacaoPDF,
  exportResultsToExcel
} from '../utils/export.js';
import ConfirmModal from './ConfirmModal.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[R$\s]/g, '');

  const hasComma = str.includes(',');
  const hasDot = str.includes('.');

  if (hasComma && hasDot) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (hasComma) {
    str = str.replace(/\./g, '').replace(',', '.');
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function safeItemName(value) {
  return String(value || '').trim();
}

function getRowQuantity(tableRows, itemName) {
  const row = (Array.isArray(tableRows) ? tableRows : []).find(
    r => safeItemName(r?.item) === safeItemName(itemName)
  );

  const qty = toNumber(row?.quantity);
  return qty && qty > 0 ? qty : 1;
}

// ─── Resumo executivo ─────────────────────────────────────────────────────────
function ExecutiveSummary({ common, exclusive, cotacoes }) {
  if (common.length === 0) return null;

  const wins = {};
  cotacoes.forEach((_, i) => { wins[i] = 0; });

  common.forEach(item => {
    const cheapest = item.entries?.find(e => e.isCheapest);
    if (cheapest && Number.isInteger(cheapest.cotacaoIdx)) {
      wins[cheapest.cotacaoIdx] = (wins[cheapest.cotacaoIdx] || 0) + 1;
    }
  });

  const winnerIdxRaw = Object.entries(wins).sort((a, b) => b[1] - a[1])[0]?.[0];
  const winnerIdx = winnerIdxRaw !== undefined ? Number(winnerIdxRaw) : undefined;

  const totalSavings = common.reduce(
    (acc, item) => acc + ((toNumber(item.savings) || 0) > 0 ? (toNumber(item.savings) || 0) : 0),
    0
  );

  const suspicious = common.filter(item => {
    if (!Array.isArray(item.entries) || item.entries.length < 2) return false;
    const prices = item.entries.map(e => toNumber(e.price)).filter(p => p && p > 0);
    if (prices.length < 2) return false;

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const min = Math.min(...prices);
    return avg > 0 && (avg - min) / avg > 0.6;
  });

  return (
    <div className="executive-summary">
      <h3 className="summary-title">Resumo da Comparação</h3>

      <div className="summary-cards">
        <div className="summary-card summary-card--winner">
          <span className="summary-card-label">Mais competitivo</span>
          <span className="summary-card-value">
            {winnerIdx !== undefined ? cotacoes[winnerIdx]?.cotacaoName || '—' : '—'}
          </span>
          <span className="summary-card-sub">
            {winnerIdx !== undefined ? `${wins[winnerIdx] || 0} de ${common.length} itens` : ''}
          </span>
        </div>

        <div className="summary-card summary-card--savings">
          <span className="summary-card-label">Economia potencial</span>
          <span className="summary-card-value">{formatCurrency(totalSavings)}</span>
          <span className="summary-card-sub">comprando sempre o mais barato</span>
        </div>

        <div className="summary-card summary-card--items">
          <span className="summary-card-label">Itens comparados</span>
          <span className="summary-card-value">{common.length}</span>
          <span className="summary-card-sub">{exclusive.length} exclusivo(s)</span>
        </div>

        <div className="summary-card summary-card--dist">
          <span className="summary-card-label">Distribuição de ganhos</span>
          <div className="wins-list">
            {cotacoes.map((c, i) => (
              <div key={i} className="wins-row">
                <span className="cotacao-badge">{i + 1}</span>
                <span className="wins-name">{c.cotacaoName}</span>
                <span className="wins-count">{wins[i] ?? 0} itens</span>
                <div className="wins-bar">
                  <div
                    className="wins-fill"
                    style={{
                      width: `${common.length > 0 ? ((wins[i] ?? 0) / common.length) * 100 : 0}%`
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {suspicious.length > 0 && (
        <div className="alert alert-warning">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ flexShrink: 0 }}
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            <strong>{suspicious.length} produto(s) com diferença de preço acima de 60%</strong>
            {' '}— verifique se a unidade de medida é a mesma em todas as cotações:{' '}
            {suspicious.map(s => s.item).join(', ')}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Plano de compra otimizado ────────────────────────────────────────────────
function PurchasePlan({ common, exclusive, cotacoes, tableRows }) {
  const [open, setOpen] = useState(false);

  const plan = useMemo(() => {
    const next = {};
    cotacoes.forEach((_, i) => { next[i] = { items: [], total: 0 }; });

    common.forEach(item => {
      const cheapest = item.entries?.find(e => e.isCheapest);
      if (!cheapest || !Number.isInteger(cheapest.cotacaoIdx)) return;

      const price = toNumber(cheapest.price);
      if (!price || price <= 0) return;

      const qty = getRowQuantity(tableRows, item.item);

      next[cheapest.cotacaoIdx].items.push({
        name: item.item,
        price,
        qty,
        total: price * qty
      });

      next[cheapest.cotacaoIdx].total += price * qty;
    });

    exclusive.forEach(item => {
      if (!Number.isInteger(item.cotacaoIdx)) return;

      const price = toNumber(item.price);
      if (!price || price <= 0) return;

      const qty = getRowQuantity(tableRows, item.item);

      next[item.cotacaoIdx].items.push({
        name: item.item,
        price,
        qty,
        total: price * qty
      });

      next[item.cotacaoIdx].total += price * qty;
    });

    return next;
  }, [common, exclusive, cotacoes, tableRows]);

  const grandTotal = Object.values(plan).reduce((a, p) => a + (p?.total || 0), 0);

  return (
    <div className="purchase-plan">
      <button
        className="purchase-plan-toggle"
        onClick={() => setOpen(o => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <path d="M16 10a4 4 0 0 1-8 0" />
        </svg>
        Plano de Compra Otimizado
        <span className="purchase-plan-total">{formatCurrency(grandTotal)}</span>
        <span className={`history-chevron ${open ? 'open' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="purchase-plan-body">
          <p className="purchase-plan-desc">
            Comprando cada item do fornecedor mais barato, seu pedido total fica:
          </p>

          <div className="plan-suppliers">
            {cotacoes.map((c, i) => {
              const p = plan[i];
              if (!p || p.items.length === 0) return null;

              return (
                <div key={i} className="plan-supplier">
                  <div className="plan-supplier-header">
                    <span className="cotacao-badge">{i + 1}</span>
                    <span className="plan-supplier-name">{c.cotacaoName}</span>
                    <span className="plan-supplier-total">{formatCurrency(p.total)}</span>
                  </div>

                  <ul className="plan-items">
                    {p.items.map((item, j) => (
                      <li key={j} className="plan-item">
                        <span className="plan-item-name">{item.name}</span>
                        <span className="plan-item-price">
                          {item.qty > 1 && (
                            <span className="plan-item-qty">
                              {item.qty}× {formatCurrency(item.price)}
                            </span>
                          )}
                          <span className="plan-item-total">{formatCurrency(item.total)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className="plan-grand-total">
            <span>Total Geral</span>
            <span>{formatCurrency(grandTotal)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
export default function ComparisonResult({
  result,
  cotacoes,
  tableRows,
  companyName,
  onBack,
  onRestart
}) {
  const common = Array.isArray(result?.common) ? result.common : [];
  const exclusive = Array.isArray(result?.exclusive) ? result.exclusive : [];

  const [pdfMenuOpen, setPdfMenuOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setPdfMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const totalSavings = common.reduce(
    (acc, item) => acc + ((toNumber(item.savings) || 0) > 0 ? (toNumber(item.savings) || 0) : 0),
    0
  );

  return (
    <div className="result-phase">
      <div className="phase-header">
        <span className="phase-tag">RESULTADO</span>
        <h2>Comparativo de Cotações</h2>
        <p>
          <strong>{common.length}</strong> produto(s) comparado(s) ·{' '}
          <strong>{exclusive.length}</strong> produto(s) exclusivo(s)
        </p>
      </div>

      <ExecutiveSummary
        common={common}
        exclusive={exclusive}
        cotacoes={cotacoes}
      />

      <PurchasePlan
        common={common}
        exclusive={exclusive}
        cotacoes={cotacoes}
        tableRows={tableRows}
      />

      <div className="result-toolbar">
        <button className="btn btn-ghost" onClick={onBack}>← Editar Tabela</button>

        <div className="toolbar-right">
          <button
            className="btn btn-secondary"
            onClick={() => exportResultsToExcel(result, cotacoes)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Excel
          </button>

          <div className="pdf-dropdown-wrapper" ref={menuRef}>
            <button
              className="btn btn-secondary"
              onClick={() => setPdfMenuOpen(prev => !prev)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              PDF
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                style={{
                  marginLeft: 2,
                  transition: 'transform 0.2s',
                  transform: pdfMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)'
                }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {pdfMenuOpen && (
              <div className="pdf-dropdown-menu">
                <button
                  className="pdf-dropdown-item pdf-dropdown-item--full"
                  onClick={() => {
                    setPdfMenuOpen(false);
                    exportResultsToPDF(result, cotacoes, companyName);
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  PDF Completo
                </button>

                <div className="pdf-dropdown-divider" />

                {cotacoes.map((cotacao, idx) => (
                  <button
                    key={idx}
                    className="pdf-dropdown-item"
                    onClick={() => {
                      setPdfMenuOpen(false);
                      exportSingleCotacaoPDF(result, cotacoes, idx, companyName);
                    }}
                  >
                    <span className="cotacao-badge" style={{ marginRight: 6 }}>{idx + 1}</span>
                    {cotacao.cotacaoName}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="btn btn-ghost" onClick={() => setConfirmRestart(true)}>
            Nova Comparação
          </button>
        </div>
      </div>

      {common.length > 0 && (
        <section className="result-section">
          <div className="section-title-row">
            <h3 className="section-title section-title--compare">
              <span className="section-icon">⇄</span> Itens Comparados
            </h3>
            <span className="section-count">{common.length} produto(s)</span>
          </div>

          <div className="table-wrapper">
            <table className="data-table result-table">
              <thead>
                <tr>
                  <th className="col-produto">Produto</th>
                  {cotacoes.map((c, i) => (
                    <th key={i} className="col-cotacao">
                      <div className="cotacao-header">
                        <span className="cotacao-badge">{i + 1}</span>
                        {c.cotacaoName}
                      </div>
                    </th>
                  ))}
                  <th className="col-winner">Mais Barato</th>
                  <th className="col-savings">Economia</th>
                </tr>
              </thead>

              <tbody>
                {common.map((item, i) => {
                  const validPrices = (item.entries || [])
                    .map(e => toNumber(e.price))
                    .filter(p => p && p > 0);

                  const isSuspicious = (() => {
                    if (validPrices.length < 2) return false;
                    const avg = validPrices.reduce((a, b) => a + b, 0) / validPrices.length;
                    const min = Math.min(...validPrices);
                    return avg > 0 && (avg - min) / avg > 0.6;
                  })();

                  return (
                    <tr key={i} className={isSuspicious ? 'row-suspicious' : ''}>
                      <td className="cell-produto">
                        <span className="cell-text">
                          {item.item}
                          {isSuspicious && (
                            <span
                              className="suspicious-badge"
                              title="Diferença de preço acima de 60% — verifique a unidade"
                            >
                              ⚠
                            </span>
                          )}
                        </span>
                      </td>

                      {cotacoes.map((_, idx) => {
                        const entry = (item.entries || []).find(e => e.cotacaoIdx === idx);
                        const entryPrice = toNumber(entry?.price);

                        return (
                          <td
                            key={idx}
                            className={`cell-price ${entryPrice ? 'has-value' : 'no-value'} ${entry?.isCheapest ? 'is-cheapest' : ''}`}
                          >
                            {entryPrice ? (
                              <span className="cell-text">
                                {formatCurrency(entryPrice)}
                                {entry.isCheapest && <span className="cheapest-badge">✓</span>}
                              </span>
                            ) : (
                              <span className="empty-dash">—</span>
                            )}
                          </td>
                        );
                      })}

                      <td className="col-winner">
                        <span className="winner-tag">{item.cheapestCotacao || '—'}</span>
                      </td>

                      <td className="col-savings">
                        {(toNumber(item.savings) || 0) > 0
                          ? <span className="savings-value">{formatCurrency(toNumber(item.savings))}</span>
                          : <span className="empty-dash">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalSavings > 0 && (
            <div className="total-savings-bar">
              <span className="total-savings-label">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ marginRight: 6, verticalAlign: 'middle' }}
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                Total de Economias
              </span>
              <span className="total-savings-value">{formatCurrency(totalSavings)}</span>
            </div>
          )}
        </section>
      )}

      {exclusive.length > 0 && (
        <section className="result-section">
          <div className="section-title-row">
            <h3 className="section-title section-title--exclusive">
              <span className="section-icon">◈</span> Itens Exclusivos
            </h3>
            <span className="section-count">{exclusive.length} produto(s)</span>
          </div>

          <p className="section-desc">
            Presentes em apenas uma cotação — não podem ser comparados.
          </p>

          <div className="table-wrapper">
            <table className="data-table result-table">
              <thead>
                <tr>
                  <th className="col-produto">Produto</th>
                  <th className="col-cotacao">Encontrado em</th>
                  <th className="col-price">Valor Unitário</th>
                </tr>
              </thead>

              <tbody>
                {exclusive.map((item, i) => {
                  const price = toNumber(item.price);

                  return (
                    <tr key={i}>
                      <td className="cell-produto">
                        <span className="cell-text">{item.item}</span>
                      </td>
                      <td className="cell-price">
                        <span className="exclusive-tag">
                          <span className="cotacao-badge">
                            {Number.isInteger(item.cotacaoIdx) ? item.cotacaoIdx + 1 : '—'}
                          </span>
                          {item.cotacao || '—'}
                        </span>
                      </td>
                      <td className={`cell-price ${price ? 'has-value' : 'no-value'}`}>
                        <span className="cell-text">
                          {price ? formatCurrency(price) : '—'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {common.length === 0 && exclusive.length === 0 && (
        <div className="table-empty">
          Nenhum item encontrado. Volte e verifique os dados.
        </div>
      )}

      {confirmRestart && (
        <ConfirmModal
          title="Iniciar nova comparação?"
          message="Todos os dados atuais serão perdidos."
          confirmLabel="Sim, começar do zero"
          cancelLabel="Cancelar"
          onConfirm={onRestart}
          onCancel={() => setConfirmRestart(false)}
          danger
        />
      )}
    </div>
  );
}