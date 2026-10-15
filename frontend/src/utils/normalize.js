function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function cleanSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeBaseText(value) {
  return cleanSpaces(
    stripAccents(value)
      .toUpperCase()
      .replace(/[^\w\s%/.:-]/g, ' ')
  );
}

function replaceCommonAbbreviations(value) {
  return value
    .replace(/\bCX\b/g, 'CAIXA')
    .replace(/\bC\/\b/g, 'COM')
    .replace(/\bS\/\b/g, 'SEM')
    .replace(/\bP\/\b/g, 'PARA')
    .replace(/\bUND\b/g, 'UNIDADE')
    .replace(/\bUNID\b/g, 'UNIDADE')
    .replace(/\bUN\b/g, 'UNIDADE')
    .replace(/\bPCT\b/g, 'PACOTE')
    .replace(/\bPCTE\b/g, 'PACOTE')
    .replace(/\bFR\b/g, 'FRASCO')
    .replace(/\bAMP\b/g, 'AMPOLA')
    .replace(/\bSOL\b/g, 'SOLUCAO')
    .replace(/\bINJ\b/g, 'INJETAVEL')
    .replace(/\bCOMP\b/g, 'COMPRIMIDO')
    .replace(/\bCAP\b/g, 'CAPSULA')
    .replace(/\bSUSP\b/g, 'SUSPENSAO')
    .replace(/\bEV\b/g, 'ENDOVENOSO')
    .replace(/\bIV\b/g, 'INTRAVENOSO')
    .replace(/\bIM\b/g, 'INTRAMUSCULAR');
}

function normalizeMeasures(value) {
  return value
    .replace(/(\d+)\s*MG\b/g, '$1MG')
    .replace(/(\d+)\s*G\b/g, '$1G')
    .replace(/(\d+)\s*KG\b/g, '$1KG')
    .replace(/(\d+)\s*ML\b/g, '$1ML')
    .replace(/(\d+)\s*L\b/g, '$1L')
    .replace(/(\d+)\s*MCG\b/g, '$1MCG')
    .replace(/(\d+)\s*UI\b/g, '$1UI')
    .replace(/(\d+)\s*MM\b/g, '$1MM')
    .replace(/(\d+)\s*CM\b/g, '$1CM')
    .replace(/(\d+)\s*X\s*(\d+)\b/g, '$1X$2')
    .replace(/(\d+)\s*\/\s*(\d+)\b/g, '$1/$2');
}

function applyDomainAliases(value) {
  return value
    .replace(/\bROLO\b/g, 'BOBINA')
    .replace(/\bTEMPORARIO\b/g, 'PROVISORIO')
    .replace(/\bSOF\.LEX\b/g, 'SOFLEX')
    .replace(/\bSOF-LEX\b/g, 'SOFLEX')
    .replace(/\bZ-350\b/g, 'Z350')
    .replace(/\bZ 350\b/g, 'Z350')
    .replace(/\bGRANDIO SO\b/g, 'GRANDIOSO')
    .replace(/\b100MM\b/g, '10CM')
    .replace(/\b150MM\b/g, '15CM')
    .replace(/\bMEDIO\b/g, 'MEDIA')
    .replace(/\bMARRON\b/g, 'MARROM')
    .replace(/\bFILME RADIOGRAFICO\b/g, 'FILME RX');
}

function removeLowValueWords(value) {
  return cleanSpaces(
    value.replace(
      /\b(DE|DA|DO|DAS|DOS|E|EM|PARA|POR|COM|SEM|TIPO|MODELO|ITEM|PRODUTO|MARCA|REF|REFERENCIA|N|NRO|NUMERO)\b/g,
      ' '
    )
  );
}

function tokenize(value) {
  return cleanSpaces(value)
    .split(' ')
    .filter(Boolean);
}

function isNumericMeasureToken(token) {
  return /^(\d+(?:[.,]\d+)?)(MG|G|KG|ML|L|MCG|UI|MM|CM|M|%)$/.test(token);
}

function isRelevantToken(token) {
  if (!token) return false;
  if (token.length <= 1) return false;
  if (/^\d+$/.test(token)) return false;
  return true;
}

const STRONG_COMMERCIAL_TOKENS = [
  'BIOPLIC', 'CLEANJOY', 'Z350', 'SINGLE', 'BOND', 'SOFLEX', 'HYDROGUM',
  'EMPRESS', 'DIRECT', 'GRANDIOSO', 'PALFIQUE', 'UNISPRAY', 'VOCO', 'IVOCLAR',
  'PACK', 'GC', 'TDV', 'MICRODONT', 'BIODINAMICA', 'ZHERMACK', 'ASFER', 'SHALON'
];

function normalizeProductName(name) {
  let value = normalizeBaseText(name);
  value = replaceCommonAbbreviations(value);
  value = normalizeMeasures(value);
  value = applyDomainAliases(value);
  value = removeLowValueWords(value);
  value = cleanSpaces(value);
  return value;
}

function getStrongCommercialTokens(name) {
  const normalized = normalizeProductName(name);
  return STRONG_COMMERCIAL_TOKENS.filter(token => normalized.includes(token));
}

function getCriticalTokens(name) {
  const normalized = normalizeProductName(name);
  const tokens = tokenize(normalized);
  return tokens.filter(token =>
    isNumericMeasureToken(token) ||
    /^[A-Z]{2,}\d+[A-Z0-9-]*$/.test(token) ||
    /^\d+\/\d+$/.test(token) ||
    /^\d+X\d+$/.test(token)
  );
}

function hasCriticalConflict(nameA, nameB) {
  // Números soltos diferentes indicam tamanho/numeração diferente ("LIMA K 25" x "LIMA K 30")
  const numbersA = tokenize(normalizeProductName(nameA)).filter(t => /^\d+$/.test(t));
  const numbersB = tokenize(normalizeProductName(nameB)).filter(t => /^\d+$/.test(t));
  if (numbersA.length > 0 && numbersB.length > 0 &&
      !numbersA.some(n => numbersB.includes(n))) return true;
  // Tamanhos diferentes (luva P x M) também são produtos diferentes
  const SIZES = ["PP", "P", "M", "G", "GG", "XG", "XGG"];
  const sizesA = tokenize(normalizeProductName(nameA)).filter(t => SIZES.includes(t));
  const sizesB = tokenize(normalizeProductName(nameB)).filter(t => SIZES.includes(t));
  if (sizesA.length > 0 && sizesB.length > 0 &&
      !sizesA.some(t => sizesB.includes(t))) return true;
  const criticalA = getCriticalTokens(nameA);
  const criticalB = getCriticalTokens(nameB);
  if (criticalA.length === 0 || criticalB.length === 0) return false;
  const measureA = criticalA.filter(isNumericMeasureToken);
  const measureB = criticalB.filter(isNumericMeasureToken);
  if (measureA.length > 0 && measureB.length > 0) {
    const sameMeasure = measureA.some(token => measureB.includes(token));
    if (!sameMeasure) return true;
  }
  const strictA = criticalA.filter(token => !isNumericMeasureToken(token));
  const strictB = criticalB.filter(token => !isNumericMeasureToken(token));
  if (strictA.length > 0 && strictB.length > 0) {
    const overlap = strictA.some(token => strictB.includes(token));
    if (!overlap) return true;
  }
  return false;
}

function getRelevantTokens(name) {
  return tokenize(normalizeProductName(name)).filter(isRelevantToken);
}

function tokenSimilarity(nameA, nameB) {
  const tokensA = [...new Set(getRelevantTokens(nameA))];
  const tokensB = [...new Set(getRelevantTokens(nameB))];
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setB = new Set(tokensB);
  const intersection = tokensA.filter(token => setB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

function containsCoreOfOther(nameA, nameB) {
  const tokensA = getRelevantTokens(nameA).filter(t => t.length >= 3);
  const tokensB = getRelevantTokens(nameB).filter(t => t.length >= 3);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const shortSet = tokensA.length <= tokensB.length ? tokensA : tokensB;
  const longSet = tokensA.length > tokensB.length ? tokensA : tokensB;
  const longTokens = new Set(longSet);
  const matched = shortSet.filter(token => longTokens.has(token)).length;
  return matched / shortSet.length >= 0.75;
}

function sameFirstStrongTokens(nameA, nameB) {
  const tokensA = getRelevantTokens(nameA).filter(t => t.length >= 4);
  const tokensB = getRelevantTokens(nameB).filter(t => t.length >= 4);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  return tokensA[0] === tokensB[0] || (tokensA[1] && tokensB[1] && tokensA[1] === tokensB[1]);
}

function boostForStrongCommercialMatch(nameA, nameB) {
  const a = getStrongCommercialTokens(nameA);
  const b = getStrongCommercialTokens(nameB);
  if (!a.length || !b.length) return 0;
  const overlap = a.filter(token => b.includes(token)).length;
  if (overlap >= 3) return 0.24;
  if (overlap === 2) return 0.18;
  if (overlap === 1) return 0.1;
  return 0;
}

function similarityScore(nameA, nameB) {
  if (!nameA || !nameB) return 0;
  const normalizedA = normalizeProductName(nameA);
  const normalizedB = normalizeProductName(nameB);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  if (hasCriticalConflict(nameA, nameB)) return 0;
  const similarity = tokenSimilarity(nameA, nameB);
  const contains = containsCoreOfOther(nameA, nameB);
  const sameStart = sameFirstStrongTokens(nameA, nameB);
  const strongBoost = boostForStrongCommercialMatch(nameA, nameB);
  let score = similarity;
  if (contains) score += 0.16;
  if (sameStart) score += 0.08;
  score += strongBoost;
  return Math.min(score, 1);
}

export function areItemsSimilar(nameA, nameB) {
  return similarityScore(nameA, nameB) >= 0.48;
}

export function normalizeItemName(name) {
  return normalizeProductName(name);
}

export function groupSimilarItems(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const groups = [];
  const used = new Set();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const current = items[i];
    const group = [current];
    used.add(i);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const candidate = items[j];
      const nameA = typeof current === 'string' ? current : current?.name || current?.canonicalName || '';
      const nameB = typeof candidate === 'string' ? candidate : candidate?.name || candidate?.canonicalName || '';
      if (areItemsSimilar(nameA, nameB)) {
        group.push(candidate);
        used.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
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

function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `row_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Achata os dados do backend ───────────────────────────────────────────────
// Agora cada item tem { name, qty, totalPrice } — sem unitPrice
// unitPrice é derivado: totalPrice / qty
function flattenCotacoesData(data) {
  const flatItems = [];

  (Array.isArray(data) ? data : []).forEach((cotacao, cotacaoIdx) => {
    (Array.isArray(cotacao?.items) ? cotacao.items : []).forEach((item) => {
      const name = String(item?.name || '').trim();
      const qty = parsePrice(item?.qty) || 1;
      const totalPrice = parsePrice(item?.totalPrice);

      if (!name || !totalPrice) return;

      flatItems.push({
        __flatIndex: flatItems.length,
        name,
        qty,
        totalPrice,
        cotacaoIdx,
        cotacaoName: cotacao?.cotacaoName || `Cotação ${cotacaoIdx + 1}`
      });
    });
  });

  return flatItems;
}

// ─── Monta prices por cotacaoIdx usando totalPrice ────────────────────────────
function buildPricesFromSources(sources = []) {
  const prices = {};

  sources.forEach((source) => {
    const idx = Number(source?.cotacaoIdx);
    const price = parsePrice(source?.totalPrice ?? source?.price);

    if (!Number.isInteger(idx) || !price) return;

    if (prices[idx] === undefined || price < prices[idx]) {
      prices[idx] = price;
    }
  });

  return prices;
}

// ─── Monta qtys por cotacaoIdx ────────────────────────────────────────────────
function buildQtysFromSources(sources = []) {
  const qtys = {};

  sources.forEach((source) => {
    const idx = Number(source?.cotacaoIdx);
    const qty = parsePrice(source?.qty) || 1;

    if (!Number.isInteger(idx)) return;

    // Mantém a qty da fonte com menor totalPrice (a mesma que foi escolhida para price)
    if (qtys[idx] === undefined) {
      qtys[idx] = qty;
    }
  });

  return qtys;
}

function buildOriginalNamesFromSources(sources = []) {
  return [...new Set(sources.map(s => s?.name).filter(Boolean))];
}

function pickCanonicalNameFromItems(items = []) {
  if (!items.length) return 'Produto';
  const sorted = [...items].sort((a, b) => {
    const scoreDiff = (b._score || 0) - (a._score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b.name || '').length - String(a.name || '').length;
  });
  return sorted[0]?.name || 'Produto';
}

function buildTableRowFromItems(items, reason = 'agrupado automaticamente') {
  const sources = items.map(item => ({
    cotacaoIdx: item.cotacaoIdx,
    cotacaoName: item.cotacaoName,
    name: item.name,
    qty: item.qty,
    totalPrice: item.totalPrice,
    price: item.totalPrice  // compatibilidade com compare.js
  }));

  return {
    id: createId(),
    item: pickCanonicalNameFromItems(items),
    prices: buildPricesFromSources(sources),
    qtys: buildQtysFromSources(sources),
    sources,
    originalNames: buildOriginalNamesFromSources(sources),
    groupReason: reason
  };
}

function scoreAgainstGroup(item, groupItems) {
  if (!groupItems.length) return 0;
  const scores = groupItems.map(g => similarityScore(item.name, g.name));
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const max = Math.max(...scores);
  return avg * 0.6 + max * 0.4;
}

function enforceGroupConstraints(groupItems, numCotacoes) {
  if (!Array.isArray(groupItems) || groupItems.length === 0) return { kept: [], overflow: [] };
  const byCotacao = new Map();
  const overflow = [];
  groupItems.forEach(item => {
    const arr = byCotacao.get(item.cotacaoIdx) || [];
    arr.push(item);
    byCotacao.set(item.cotacaoIdx, arr);
  });
  const kept = [];
  for (const [, items] of byCotacao.entries()) {
    const sorted = [...items].sort((a, b) => (b._score || 0) - (a._score || 0));
    kept.push(sorted[0]);
    if (sorted.length > 1) overflow.push(...sorted.slice(1));
  }
  if (kept.length > numCotacoes) {
    const sorted = [...kept].sort((a, b) => (b._score || 0) - (a._score || 0));
    return { kept: sorted.slice(0, numCotacoes), overflow: [...overflow, ...sorted.slice(numCotacoes)] };
  }
  return { kept, overflow };
}

function redistributeOverflow(groups, overflowItems, numCotacoes) {
  const leftovers = [];
  overflowItems.forEach(item => {
    let bestGroupIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.some(g => g.cotacaoIdx === item.cotacaoIdx)) continue;
      if (group.length >= numCotacoes) continue;
      const score = scoreAgainstGroup(item, group);
      if (score > bestScore) { bestScore = score; bestGroupIdx = i; }
    }
    if (bestGroupIdx >= 0 && bestScore >= 0.5) {
      item._score = bestScore;
      groups[bestGroupIdx].push(item);
    } else {
      leftovers.push(item);
    }
  });
  leftovers.forEach(item => { groups.push([{ ...item, _score: 1 }]); });
  return groups;
}

function buildGroupsLocally(flatItems, numCotacoes) {
  if (!flatItems.length) return [];
  const items = flatItems.map(item => ({ ...item }));
  const used = new Set();
  const rawGroups = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const base = items[i];
    const group = [{ ...base, _score: 1 }];
    used.add(i);
    const candidates = [];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const candidate = items[j];
      const score = similarityScore(base.name, candidate.name);
      if (score >= 0.44) candidates.push({ idx: j, item: { ...candidate, _score: score }, score });
    }
    candidates.sort((a, b) => b.score - a.score).forEach(({ idx, item }) => {
      if (group.some(g => g.cotacaoIdx === item.cotacaoIdx)) return;
      if (group.length >= numCotacoes) return;
      const scoreToGroup = scoreAgainstGroup(item, group);
      if (scoreToGroup >= 0.46) { item._score = scoreToGroup; group.push(item); used.add(idx); }
    });
    rawGroups.push(group);
  }
  let finalGroups = [];
  let overflow = [];
  rawGroups.forEach(group => {
    const constrained = enforceGroupConstraints(group, numCotacoes);
    if (constrained.kept.length > 0) finalGroups.push(constrained.kept);
    overflow.push(...constrained.overflow);
  });
  finalGroups = redistributeOverflow(finalGroups, overflow, numCotacoes);
  return finalGroups;
}

function buildRowsFromGroupedItems(groupedItems, numCotacoes) {
  const rows = groupedItems.map(group => {
    const reason = group.length === 1 ? 'produto único' : 'agrupado automaticamente';
    const constrained = enforceGroupConstraints(group, numCotacoes);
    return buildTableRowFromItems(constrained.kept, reason);
  });
  return rows.sort((a, b) =>
    String(a.item || '').localeCompare(String(b.item || ''), 'pt-BR', { sensitivity: 'base' })
  );
}

function normalizeBackendGroups(rawGroups, flatItems, numCotacoes) {
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
    return buildGroupsLocally(flatItems, numCotacoes);
  }
  const grouped = [];
  const usedIndices = new Set();
  const overflow = [];
  rawGroups.forEach((group) => {
    const indices = Array.isArray(group?.indices) ? group.indices : [];
    const items = indices.map(idx => flatItems[idx]).filter(Boolean).map(item => ({ ...item }));
    if (items.length === 0) return;
    const canonical = group?.canonicalName || pickCanonicalNameFromItems(items);
    const scoredItems = items.map(item => ({
      ...item,
      _score: similarityScore(canonical, item.name) || 0.5
    }));
    const constrained = enforceGroupConstraints(scoredItems, numCotacoes);
    if (constrained.kept.length > 0) {
      grouped.push(constrained.kept);
      constrained.kept.forEach(item => usedIndices.add(item.__flatIndex));
    }
    constrained.overflow.forEach(item => overflow.push(item));
  });
  const unassigned = flatItems
    .filter(item => !usedIndices.has(item.__flatIndex))
    .map(item => ({ ...item, _score: 1 }));
  let finalGroups = [...grouped];
  finalGroups = redistributeOverflow(finalGroups, [...overflow, ...unassigned], numCotacoes);
  return finalGroups;
}

export function buildTableRowsSync(data) {
  const flatItems = flattenCotacoesData(data);
  if (flatItems.length === 0) return [];
  const numCotacoes = Math.max(1, Array.isArray(data) ? data.length : 1);
  const localGroups = buildGroupsLocally(flatItems, numCotacoes);
  return buildRowsFromGroupedItems(localGroups, numCotacoes);
}

export async function buildTableRows(data) {
  const flatItems = flattenCotacoesData(data);
  if (flatItems.length === 0) return [];
  const numCotacoes = Math.max(1, Array.isArray(data) ? data.length : 1);
  try {
    const response = await fetch(`${import.meta.env.VITE_API_URL}/api/group-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: flatItems.map(item => ({
          name: item.name,
          cotacaoIdx: item.cotacaoIdx,
          cotacaoName: item.cotacaoName
        })),
        numCotacoes
      })
    });
    const result = await response.json();
    if (!result?.success || !Array.isArray(result?.groups)) {
      throw new Error(result?.error || 'Falha no agrupamento');
    }
    const normalizedGroups = normalizeBackendGroups(result.groups, flatItems, numCotacoes);
    return buildRowsFromGroupedItems(normalizedGroups, numCotacoes);
  } catch (err) {
    console.warn('Falha no agrupamento assíncrono, usando fallback local:', err);
    return buildTableRowsSync(data);
  }
}
