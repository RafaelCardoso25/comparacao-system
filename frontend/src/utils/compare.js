function safeItemName(value) {
  return String(value || '').trim();
}

function parsePrice(value) {
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
  return Number.isFinite(num) && num > 0 ? num : null;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sortByItem(arr) {
  return [...arr].sort((a, b) =>
    safeItemName(a.item).localeCompare(safeItemName(b.item), 'pt-BR', { sensitivity: 'base' })
  );
}

function getSourcePrice(source) {
  return (
    parsePrice(source?.totalPrice) ??
    parsePrice(source?.price) ??
    null
  );
}

function getSourceQty(source) {
  return parsePrice(source?.qty) || 1;
}

function getSourceName(source, cotacoes) {
  return (
    source?.cotacaoName ||
    (Number.isInteger(source?.cotacaoIdx) ? cotacoes[source.cotacaoIdx]?.cotacaoName : null) ||
    `Cotação ${(source?.cotacaoIdx ?? 0) + 1}`
  );
}

function buildPresentIn(row, cotacoes) {
  if (Array.isArray(row.sources) && row.sources.length > 0) {
    const bestByCotacao = {};

    row.sources.forEach((source) => {
      const cotacaoIdx = Number(source?.cotacaoIdx);
      if (!Number.isInteger(cotacaoIdx) || cotacaoIdx < 0) return;

      const price = getSourcePrice(source);
      if (!price || price <= 0) return;

      const qty = getSourceQty(source);
      const current = bestByCotacao[cotacaoIdx];

      if (!current || price < current.price) {
        bestByCotacao[cotacaoIdx] = {
          cotacaoName: getSourceName(source, cotacoes),
          cotacaoIdx,
          price: roundMoney(price),
          qty,
          originalName: safeItemName(source?.name || row.item)
        };
      }
    });

    return Object.values(bestByCotacao).sort((a, b) => a.cotacaoIdx - b.cotacaoIdx);
  }

  // Fallback: lê direto de row.prices e row.qtys
  return cotacoes
    .map((cotacao, idx) => {
      const price = parsePrice(row.prices?.[idx]);
      if (!price || price <= 0) return null;
      const qty = parsePrice(row.qtys?.[idx]) || 1;
      return {
        cotacaoName: cotacao.cotacaoName,
        cotacaoIdx: idx,
        price: roundMoney(price),
        qty,
        originalName: safeItemName(row.item)
      };
    })
    .filter(Boolean);
}

export function compareItems(tableRows, cotacoes) {
  const common = [];
  const exclusive = [];

  (Array.isArray(tableRows) ? tableRows : []).forEach((row) => {
    const itemName = safeItemName(row?.item);
    if (!itemName) return;

    const presentIn = buildPresentIn(row, cotacoes);

    if (presentIn.length >= 2) {
      const sorted = [...presentIn].sort((a, b) => a.price - b.price);
      const cheapest = sorted[0];
      const highest = sorted[sorted.length - 1];

      common.push({
        item: itemName,
        reason: row?.reason || '',
        entries: presentIn.map((e) => ({
          cotacao: e.cotacaoName,
          cotacaoIdx: e.cotacaoIdx,
          price: e.price,
          qty: e.qty,
          originalName: e.originalName,
          isCheapest: e.cotacaoIdx === cheapest.cotacaoIdx
        })),
        cheapestCotacao: cheapest.cotacaoName,
        cheapestCotacaoIdx: cheapest.cotacaoIdx,
        cheapestPrice: cheapest.price,
        savings: sorted.length > 1 ? roundMoney(highest.price - cheapest.price) : 0
      });
    } else if (presentIn.length === 1) {
      const only = presentIn[0];
      exclusive.push({
        item: itemName,
        reason: row?.reason || 'Presente em apenas uma cotação',
        cotacao: only.cotacaoName,
        cotacaoIdx: only.cotacaoIdx,
        price: only.price,
        qty: only.qty,
        originalName: only.originalName
      });
    }
  });

  return {
    common: sortByItem(common),
    exclusive: sortByItem(exclusive)
  };
}