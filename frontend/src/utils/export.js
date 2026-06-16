import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || '').trim();
}

function buildFileName(base, extension) {
  const now = new Date();
  const date = now.toLocaleDateString('pt-BR').replace(/\//g, '-');
  const time = now
    .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    .replace(':', '-');
  return `${base}_${date}_${time}.${extension}`;
}

export function formatCurrency(value) {
  const num = toNumber(value);
  if (num === null) return '—';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(num);
}

function autoSizeWorksheetColumns(ws, rows) {
  if (!rows.length) return;
  const widths = [];
  rows.forEach(row => {
    row.forEach((cell, colIdx) => {
      const len = String(cell ?? '').length;
      widths[colIdx] = Math.max(widths[colIdx] || 10, Math.min(len + 2, 45));
    });
  });
  ws['!cols'] = widths.map(w => ({ wch: w }));
}

function applyCurrencyFormat(ws, rows, currencyCols) {
  for (let r = 1; r < rows.length; r++) {
    currencyCols.forEach(c => {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = ws[ref];
      if (cell && typeof cell.v === 'number') {
        cell.z = '"R$" #,##0.00';
      }
    });
  }
}

export function exportTableToExcel(tableRows, cotacoes = []) {
  const rows = safeArray(tableRows);

  const header = [
    'Produto',
    'Quantidade',
    ...safeArray(cotacoes).map((c, i) => c?.cotacaoName || `Cotação ${i + 1}`)
  ];

  const body = rows.map(row => {
    const prices = safeArray(cotacoes).map((_, idx) => {
      const direct = row?.prices?.[idx];
      return toNumber(direct) ?? '';
    });
    return [
      safeString(row?.item),
      toNumber(row?.quantity) ?? 1,
      ...prices
    ];
  });

  const allRows = [header, ...body];
  const ws = XLSX.utils.aoa_to_sheet(allRows);
  const wb = XLSX.utils.book_new();

  autoSizeWorksheetColumns(ws, allRows);
  applyCurrencyFormat(ws, allRows, safeArray(cotacoes).map((_, idx) => idx + 2));

  XLSX.utils.book_append_sheet(wb, ws, 'Tabela');
  XLSX.writeFile(wb, buildFileName('tabela_comparacao', 'xlsx'));
}

export function exportResultsToExcel(result, cotacoes = []) {
  const common = safeArray(result?.common);
  const exclusive = safeArray(result?.exclusive);

  const cotacaoNames = safeArray(cotacoes).map((c, i) => c?.cotacaoName || `Cotação ${i + 1}`);
  const totalSavings = common.reduce((acc, item) => acc + (toNumber(item?.savings) || 0), 0);

  const resumoRows = [
    ['Indicador', 'Valor'],
    ['Itens comparados', common.length],
    ['Itens exclusivos', exclusive.length],
    ['Economia total', totalSavings],
    ['Lucro total estimado', totalSavings]
  ];

  const comparativoHeader = [
    'Produto',
    ...cotacaoNames,
    'Mais barato',
    'Preço mais barato',
    'Economia',
    'Lucro estimado',
    'Tipo'
  ];

  const comparativoRows = [comparativoHeader];

  common.forEach(item => {
    const savings = toNumber(item?.savings) || 0;
    const row = [safeString(item?.item)];
    cotacaoNames.forEach((_, idx) => {
      const entry = safeArray(item?.entries).find(e => e?.cotacaoIdx === idx);
      row.push(toNumber(entry?.price) ?? '');
    });
    row.push(safeString(item?.cheapestCotacao) || '');
    row.push(toNumber(item?.cheapestPrice) ?? '');
    row.push(savings);
    row.push(savings);
    row.push('Comparado');
    comparativoRows.push(row);
  });

  exclusive.forEach(item => {
    const row = [safeString(item?.item)];
    cotacaoNames.forEach((_, idx) => {
      row.push(idx === item?.cotacaoIdx ? (toNumber(item?.price) ?? '') : '');
    });
    row.push(safeString(item?.cotacao) || '');
    row.push(toNumber(item?.price) ?? '');
    row.push('');
    row.push('');
    row.push('Exclusivo');
    comparativoRows.push(row);
  });

  const comparadosRows = [[
    'Produto',
    ...cotacaoNames,
    'Mais barato',
    'Preço mais barato',
    'Economia',
    'Lucro estimado'
  ]];

  common.forEach(item => {
    const savings = toNumber(item?.savings) || 0;
    const row = [safeString(item?.item)];
    cotacaoNames.forEach((_, idx) => {
      const entry = safeArray(item?.entries).find(e => e?.cotacaoIdx === idx);
      row.push(toNumber(entry?.price) ?? '');
    });
    row.push(safeString(item?.cheapestCotacao) || '');
    row.push(toNumber(item?.cheapestPrice) ?? '');
    row.push(savings);
    row.push(savings);
    comparadosRows.push(row);
  });

  const exclusivosRows = [['Produto', 'Fornecedor', 'Cotação', 'Valor unitário', 'Tipo']];
  exclusive.forEach(item => {
    exclusivosRows.push([
      safeString(item?.item),
      safeString(item?.cotacao),
      Number.isInteger(item?.cotacaoIdx) ? item.cotacaoIdx + 1 : '',
      toNumber(item?.price) ?? '',
      'Exclusivo'
    ]);
  });

  const wb = XLSX.utils.book_new();

  const wsResumo     = XLSX.utils.aoa_to_sheet(resumoRows);
  const wsComparativo = XLSX.utils.aoa_to_sheet(comparativoRows);
  const wsComparados  = XLSX.utils.aoa_to_sheet(comparadosRows);
  const wsExclusivos  = XLSX.utils.aoa_to_sheet(exclusivosRows);

  autoSizeWorksheetColumns(wsResumo,      resumoRows);
  autoSizeWorksheetColumns(wsComparativo, comparativoRows);
  autoSizeWorksheetColumns(wsComparados,  comparadosRows);
  autoSizeWorksheetColumns(wsExclusivos,  exclusivosRows);

  applyCurrencyFormat(wsResumo, resumoRows, [1]);

  const cotacaoCols = cotacaoNames.map((_, idx) => idx + 1);

  applyCurrencyFormat(wsComparativo, comparativoRows, [
    ...cotacaoCols,
    cotacaoNames.length + 2,
    cotacaoNames.length + 3,
    cotacaoNames.length + 4
  ]);
  applyCurrencyFormat(wsComparados, comparadosRows, [
    ...cotacaoCols,
    cotacaoNames.length + 2,
    cotacaoNames.length + 3,
    cotacaoNames.length + 4
  ]);
  applyCurrencyFormat(wsExclusivos, exclusivosRows, [3]);

  XLSX.utils.book_append_sheet(wb, wsResumo,      'Financeiro');
  XLSX.utils.book_append_sheet(wb, wsComparativo, 'Comparativo');
  XLSX.utils.book_append_sheet(wb, wsComparados,  'Comparados');
  XLSX.utils.book_append_sheet(wb, wsExclusivos,  'Exclusivos');

  XLSX.writeFile(wb, buildFileName('comparativo_cotacoes', 'xlsx'));
}

export function exportResultsToPDF(result, cotacoes, companyName = '') {
  const common    = safeArray(result?.common);
  const exclusive = safeArray(result?.exclusive);

  const doc = new jsPDF('l', 'mm', 'a4');

  doc.setFontSize(16);
  doc.text(
    companyName
      ? `Comparativo de Cotações - ${companyName}`
      : 'Comparativo de Cotações',
    14, 15
  );
  doc.setFontSize(10);
  doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, 14, 22);

  autoTable(doc, {
    startY: 30,
    head: [[
      'Produto',
      ...safeArray(cotacoes).map((c, i) => c?.cotacaoName || `Cotação ${i + 1}`),
      'Mais Barato',
      'Preço',
      'Economia'
    ]],
    body: common.map(item => [
      safeString(item?.item),
      ...safeArray(cotacoes).map((_, idx) => {
        const entry = safeArray(item?.entries).find(e => e?.cotacaoIdx === idx);
        return entry ? formatCurrency(entry?.price) : '—';
      }),
      safeString(item?.cheapestCotacao) || '—',
      formatCurrency(item?.cheapestPrice),
      formatCurrency(item?.savings)
    ]),
    styles: { fontSize: 8, cellPadding: 2 }
  });

  if (exclusive.length > 0) {
    const nextY = (doc.lastAutoTable?.finalY || 30) + 10;
    autoTable(doc, {
      startY: nextY,
      head: [['Produto', 'Encontrado em', 'Valor Unitário']],
      body: exclusive.map(item => [
        safeString(item?.item),
        safeString(item?.cotacao),
        formatCurrency(item?.price)
      ]),
      styles: { fontSize: 9, cellPadding: 2 }
    });
  }

  doc.save(buildFileName('comparativo_cotacoes', 'pdf'));
}

// FIX: exporta apenas os itens onde este fornecedor é o mais barato
export function exportSingleCotacaoPDF(result, cotacoes, cotacaoIdx, companyName = '') {
  const common    = safeArray(result?.common);
  const exclusive = safeArray(result?.exclusive);
  const cotacao   = safeArray(cotacoes)[cotacaoIdx];
  const cotacaoName = cotacao?.cotacaoName || `Cotação ${cotacaoIdx + 1}`;

  const doc = new jsPDF('p', 'mm', 'a4');

  // ── Cabeçalho ──────────────────────────────────────────────────────────────
  doc.setFontSize(16);
  doc.text(
    companyName
      ? `Pedido para: ${cotacaoName} — ${companyName}`
      : `Pedido para: ${cotacaoName}`,
    14, 15
  );
  doc.setFontSize(10);
  doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, 14, 22);

  // ── Itens onde este fornecedor é o mais barato (produtos comparados) ───────
  const cheapestRows = [];
  let totalCheapest = 0;

  common.forEach(item => {
    const entry = safeArray(item?.entries).find(e => e?.cotacaoIdx === cotacaoIdx);
    // FIX: só inclui se for o mais barato
    if (!entry || !entry.isCheapest) return;

    const price = toNumber(entry.price) || 0;
    const qty   = toNumber(entry.qty)   || 1;

    cheapestRows.push([
      safeString(item?.item),
      String(qty),
      formatCurrency(price),
    ]);

    totalCheapest += price;
  });

  // ── Itens exclusivos deste fornecedor ──────────────────────────────────────
  const exclusiveRows = [];
  let totalExclusive = 0;

  exclusive
    .filter(item => item?.cotacaoIdx === cotacaoIdx)
    .forEach(item => {
      const price = toNumber(item.price) || 0;
      const qty   = toNumber(item.qty)   || 1;

      exclusiveRows.push([
        safeString(item?.item),
        String(qty),
        formatCurrency(price),
      ]);

      totalExclusive += price;
    });

  const grandTotal = totalCheapest + totalExclusive;

  // ── Tabela: itens mais baratos ─────────────────────────────────────────────
  if (cheapestRows.length > 0) {
    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    doc.text('Itens mais baratos neste fornecedor', 14, 30);
    doc.setFont(undefined, 'normal');

    autoTable(doc, {
      startY: 34,
      head: [['Produto', 'Qtd', 'Preço Total']],
      body: cheapestRows,
      foot: [[
        { content: 'Subtotal', colSpan: 2, styles: { fontStyle: 'bold' } },
        { content: formatCurrency(totalCheapest), styles: { fontStyle: 'bold' } }
      ]],
      footStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0] },
      styles: { fontSize: 9, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 'auto' },
        1: { cellWidth: 20, halign: 'center' },
        2: { cellWidth: 35, halign: 'right' }
      }
    });
  }

  // ── Tabela: itens exclusivos ───────────────────────────────────────────────
  if (exclusiveRows.length > 0) {
    const nextY = (doc.lastAutoTable?.finalY || 34) + 10;

    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    doc.text('Itens exclusivos neste fornecedor', 14, nextY);
    doc.setFont(undefined, 'normal');

    autoTable(doc, {
      startY: nextY + 4,
      head: [['Produto', 'Qtd', 'Preço Total']],
      body: exclusiveRows,
      foot: [[
        { content: 'Subtotal', colSpan: 2, styles: { fontStyle: 'bold' } },
        { content: formatCurrency(totalExclusive), styles: { fontStyle: 'bold' } }
      ]],
      footStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0] },
      styles: { fontSize: 9, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 'auto' },
        1: { cellWidth: 20, halign: 'center' },
        2: { cellWidth: 35, halign: 'right' }
      }
    });
  }

  // ── Total geral ────────────────────────────────────────────────────────────
  if (cheapestRows.length > 0 || exclusiveRows.length > 0) {
    const finalY = (doc.lastAutoTable?.finalY || 34) + 8;

    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text('TOTAL GERAL:', 14, finalY);
    doc.text(formatCurrency(grandTotal), 195, finalY, { align: 'right' });
    doc.setFont(undefined, 'normal');
  } else {
    // Fornecedor não é o mais barato em nenhum item
    const finalY = (doc.lastAutoTable?.finalY || 34) + 8;
    doc.setFontSize(11);
    doc.text(
      'Este fornecedor não é o mais barato em nenhum item comparado.',
      14, finalY
    );
  }

  doc.save(buildFileName(`pedido_${cotacaoName.replace(/\s+/g, '_')}`, 'pdf'));
}