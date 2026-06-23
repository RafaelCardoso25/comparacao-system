import Fuse from 'fuse.js';

// ─── Configuração do Fuse.js ───────────────────────────────────────────────
// 0.35 permite capturar variações comuns (abreviações, ordem de palavras)
// sem criar falsos positivos. O Gemini resolve os casos ambíguos restantes.
const FUSE_OBVIOUS_THRESHOLD = 0.35;

// ─── Stopwords pt-BR para remover antes da comparação ─────────────────────
const STOPWORDS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'com', 'para', 'por', 'ao', 'aos', 'a', 'e', 'o', 'um', 'uma'
]);

// ─── Normalização agressiva para comparação ────────────────────────────────
/**
 * Prepara o nome do produto para comparação pelo Fuse.js.
 * Remove stopwords, normaliza concentrações e info de embalagem.
 *
 * Exemplos:
 *   "Fio de Nylon 4-0 Agulhado cx 12un" → "fio nylon 40 agulhado"
 *   "Amoxicilina 500 mg 21 cápsulas"    → "amoxicilina 500mg"
 *   "Luva de Procedimento M Latex"      → "luva procedimento m latex"
 */
export function normalizeForComparison(name) {
  if (!name || typeof name !== 'string') return '';

  let result = name
    .toLowerCase()
    // Remove acentos
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Normaliza separadores de concentração: 4-0, 4/0, 4.0 → 40
    .replace(/(\d+)[\/\-\.](\d+)/g, '$1$2')
    // Normaliza "500 mg" → "500mg", "100 ml" → "100ml"
    .replace(/(\d+)\s*(mg|ml|mcg|ui|g|kg|l|%)(?=\s|$)/g, '$1$2')
    // Remove informações de embalagem (cx, fr, amp, env, un, cp, comp, caps, cps, bl, kt)
    .replace(/\b(cx|fr|amp|env|un|unid|cp|comp|caps|cps|bl|kt|caixa|frasco|ampola|envelope|blister|kit)\b[\s\d]*/g, '')
    // Remove pontuação exceto letras, números e espaço
    .replace(/[^a-z0-9\s]/g, ' ')
    // Colapsa espaços
    .replace(/\s+/g, ' ')
    .trim();

  // Remove stopwords
  result = result
    .split(' ')
    .filter(word => word.length > 0 && !STOPWORDS.has(word))
    .join(' ');

  return result;
}

/**
 * Passo 1: Fuse.js agrupa apenas matches óbvios.
 * Com normalização agressiva + threshold 0.35, captura:
 * - Stopwords diferentes: "Luva de Procedimento" = "Luva Procedimento"
 * - Separadores de concentração: "Fio 4-0" = "Fio 4.0"
 * - Info de embalagem: "Amox 500mg cx21" ≈ "Amoxicilina 500mg"
 */
function groupObvious(names) {
  const prepared = names.map(normalizeForComparison);
  const visited = new Array(names.length).fill(false);
  const groups = [];

  for (let i = 0; i < prepared.length; i++) {
    if (visited[i]) continue;

    const group = [i];
    visited[i] = true;

    const candidates = prepared
      .map((name, idx) => ({ name, idx }))
      .filter(({ idx }) => !visited[idx]);

    if (candidates.length === 0) {
      groups.push(group);
      continue;
    }

    const fuse = new Fuse(candidates, {
      keys: ['name'],
      threshold: FUSE_OBVIOUS_THRESHOLD,
      includeScore: true,
      minMatchCharLength: 3,
    });

    const results = fuse.search(prepared[i]);
    for (const result of results) {
      const score = result.score ?? 1;
      if (score <= FUSE_OBVIOUS_THRESHOLD) {
        group.push(result.item.idx);
        visited[result.item.idx] = true;
      }
    }

    groups.push(group);
  }

  return groups;
}

/**
 * Passo 2: Gemini agrupa semanticamente e retorna canonicalName por grupo.
 * Recebe os nomes representativos de cada grupo do Fuse.js.
 * Uma única requisição para todos os itens.
 *
 * @returns {Array<{ indices: number[], canonicalName: string }>}
 */
async function groupWithGemini(representativeNames) {
  if (representativeNames.length <= 1) {
    return representativeNames.map((name, i) => ({ indices: [i], canonicalName: name }));
  }

  try {
    const response = await fetch(`${import.meta.env.VITE_API_URL}/api/group-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: representativeNames }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!data.success || !data.groups) throw new Error('Resposta inválida');

    // Garante que todos os índices estão cobertos
    const allIndices = new Set(data.groups.flatMap(g => g.indices ?? g));
    const missing = representativeNames
      .map((name, i) => ({ name, i }))
      .filter(({ i }) => !allIndices.has(i));

    if (missing.length > 0) {
      missing.forEach(({ name, i }) =>
        data.groups.push({ indices: [i], canonicalName: name })
      );
    }

    return data.groups;
  } catch (err) {
    console.warn('Gemini grouping falhou, sem agrupamento semântico:', err.message);
    return representativeNames.map((name, i) => ({ indices: [i], canonicalName: name }));
  }
}

/**
 * Função principal — orquestra Fuse.js (óbvios) + Gemini (semântico).
 *
 * Fluxo:
 * 1. Fuse.js agrupa matches óbvios com normalização agressiva (threshold 0.35)
 * 2. Gemini recebe um nome por grupo e decide quais são o mesmo produto,
 *    retornando também um canonicalName padronizado
 * 3. Os grupos do Fuse.js que o Gemini decidiu mesclar são combinados,
 *    usando o canonicalName do Gemini como nome final
 *
 * @param {string[]} names - todos os nomes de produtos de todas as cotações
 * @returns {Promise<Array<{ indices: number[], canonicalName: string }>>}
 */
export async function groupProductNames(names) {
  if (!names || names.length === 0) return [];
  if (names.length === 1) return [{ indices: [0], canonicalName: names[0] }];

  // Passo 1: agrupa matches óbvios com Fuse.js
  const fuseGroups = groupObvious(names);

  // Passo 2: pega um nome representativo por grupo para mandar ao Gemini
  const representatives = fuseGroups.map(group => names[group[0]]);

  // Passo 3: Gemini decide quais grupos representam o mesmo produto
  const geminiGroups = await groupWithGemini(representatives);

  // Passo 4: mescla os grupos do Fuse.js conforme a decisão do Gemini
  // O canonicalName do Gemini prevalece como nome final do grupo
  const finalGroups = geminiGroups.map(geminiGroup => {
    const allOriginalIndices = (geminiGroup.indices ?? geminiGroup).flatMap(
      fuseGroupIdx => fuseGroups[fuseGroupIdx] ?? []
    );
    return {
      indices: allOriginalIndices,
      canonicalName: geminiGroup.canonicalName ?? names[allOriginalIndices[0]] ?? ''
    };
  });

  return finalGroups;
}