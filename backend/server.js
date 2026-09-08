import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

dotenv.config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();

// TEMPORARIO: loga toda requisicao para identificar o que mantem o servico
// acordado no Render (o free tier so hiberna apos 15 min sem trafego).
// Remover depois de identificar a origem.
app.use((req, res, next) => {
  const t0 = Date.now();
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '?';
  const ua = (req.headers['user-agent'] || '-').slice(0, 120);
  const ref = req.headers['referer'] || '-';
  res.on('finish', () => {
    console.log(
      `[REQ] ${req.method} ${req.originalUrl} ${res.statusCode} ` +
        `${Date.now() - t0}ms ip=${ip} ua="${ua}" ref="${ref}"`
    );
  });
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Apenas arquivos PDF são aceitos.'));
  }
});

// Groq principal (chave 1) e fallback (chave 2 gratuita)
const groqPrimary = new Groq({ apiKey: process.env.GROQ_API_KEY });
const groqFallback = process.env.GROQ_API_KEY_2
  ? new Groq({ apiKey: process.env.GROQ_API_KEY_2 })
  : null;
const MODEL = 'llama-3.3-70b-versatile';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Claude (Anthropic) como fallback final quando as duas chaves Groq falharem
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const STRONG_COMMERCIAL_TOKENS = [
  'BIOPLIC','CLEANJOY','Z350','SINGLE','BOND','SOFLEX','HYDROGUM',
  'EMPRESS','DIRECT','GRANDIOSO','PALFIQUE','UNISPRAY','VOCO','IVOCLAR',
  'PACK','GC','TDV','MICRODONT','BIODINAMICA','ZHERMACK','ASFER','SHALON'
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────────────────────────────────────

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch { return []; }
}

function writeHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar histórico:', err.message);
  }
}

function parseBrazilianNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/[R$\s]/g, '');
  const hasComma = s.includes(',');
  const hasDot   = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function safeString(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function repairTruncatedJSON(str) {
  try {
    let s = str.trim();
    s = s.replace(/,\s*$/, '');
    let openBraces = 0, openBrackets = 0, inString = false, escape = false;
    for (const ch of s) {
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }
    const lastComma = s.lastIndexOf('},{');
    if (lastComma > 0 && (openBraces > 0 || openBrackets > 0)) {
      s = s.slice(0, lastComma + 1).replace(/,\s*$/, '');
    }
    for (let i = 0; i < openBrackets; i++) s += ']';
    for (let i = 0; i < openBraces; i++) s += '}';
    return JSON.parse(s);
  } catch { return null; }
}

function parseAIResponse(raw) {
  if (!raw) throw new Error('Resposta vazia');
  try { return JSON.parse(raw); } catch {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {
        const repaired = repairTruncatedJSON(match[0]);
        if (repaired) return repaired;
      }
    }
    throw new Error(`Sem JSON válido: ${cleaned.slice(0, 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAMADAS DE IA
// ─────────────────────────────────────────────────────────────────────────────

function isGroqRateLimit(err) {
  const msg = err?.message || String(err || '');
  return msg.includes('tokens per day') || msg.includes('rate_limit_exceeded') ||
    msg.includes('429') || msg.toLowerCase().includes('rate_limit');
}

function isGroqServer(err) {
  const msg = err?.message || String(err || '');
  return msg.includes('503') || msg.includes('fetch failed') || msg.includes('ECONNRESET');
}

async function callClaude(systemPrompt, userPrompt) {
  if (!anthropic) throw new Error('Claude não configurado');
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const raw = response?.content?.find(b => b.type === 'text')?.text?.trim();
  if (!raw) throw new Error('Resposta vazia do Claude');
  return parseAIResponse(raw);
}

async function callGroqWithClient(client, label, systemPrompt, userPrompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.05,
        max_tokens: 4000
      });
      const raw = response?.choices?.[0]?.message?.content?.trim();
      if (!raw) throw new Error(`Resposta vazia do ${label}`);
      return parseAIResponse(raw);
    } catch (err) {
      const msg = err?.message || String(err || '');
      console.error(`[${label}] Erro tentativa ${attempt}:`, msg);
      if (msg.includes('tokens per day') || msg.includes('rate_limit_exceeded')) throw err;
      if ((isGroqRateLimit(err) || isGroqServer(err)) && attempt < retries) {
        await sleep(attempt * 8000); continue;
      }
      throw err;
    }
  }
}

// Cadeia de fallback: Groq chave 1 → Groq chave 2 → Claude
async function callAI(systemPrompt, userPrompt, retries = 3) {
  try {
    return await callGroqWithClient(groqPrimary, 'Groq#1', systemPrompt, userPrompt, retries);
  } catch (groqErr) {
    const msg = groqErr?.message || String(groqErr || '');
    console.warn(`[AI] Groq chave 1 falhou (${msg.slice(0, 80)}), tentando chave 2...`);

    if (groqFallback) {
      try {
        const result = await callGroqWithClient(groqFallback, 'Groq#2', systemPrompt, userPrompt, retries);
        console.log('[AI] Groq chave 2 OK');
        return result;
      } catch (groq2Err) {
        console.error('[AI] Groq chave 2 falhou:', groq2Err?.message);
      }
    }

    if (anthropic) {
      try {
        const result = await callClaude(systemPrompt, userPrompt);
        console.log('[AI] Claude OK');
        return result;
      } catch (claudeErr) {
        console.error('[AI] Claude falhou:', claudeErr?.message);
      }
    }

    throw groqErr;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRAÇÃO DE TEXTO COM pdfjs-dist
// ─────────────────────────────────────────────────────────────────────────────

async function extractTextWithPdfjs(fileBuffer) {
  try {
    const uint8 = new Uint8Array(fileBuffer);
    const loadingTask = getDocument({
      data: uint8,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true
    });
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    const allLines = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const content = await page.getTextContent();

      const lineMap = new Map();
      for (const item of content.items) {
        const text = item.str;
        if (!text || !text.trim()) continue;
        const x = item.transform[4];
        const y = Math.round(item.transform[5] / 2) * 2;
        const key = `${pageNum}_${y}`;
        if (!lineMap.has(key)) lineMap.set(key, []);
        lineMap.get(key).push({ text: text.trim(), x, width: item.width || 0 });
      }

      const sortedKeys = [...lineMap.keys()].sort((a, b) => {
        const [pA, yA] = a.split('_').map(Number);
        const [pB, yB] = b.split('_').map(Number);
        if (pA !== pB) return pA - pB;
        return yB - yA;
      });

      for (const key of sortedKeys) {
        const tokens = lineMap.get(key).sort((a, b) => a.x - b.x);
        if (!tokens.length) continue;

        const gaps = [];
        for (let i = 1; i < tokens.length; i++) {
          const gap = tokens[i].x - (tokens[i - 1].x + tokens[i - 1].width);
          gaps.push(gap);
        }

        const sortedGaps = [...gaps].sort((a, b) => a - b);
        const p75Gap = sortedGaps[Math.floor(sortedGaps.length * 0.75)] || 0;
        const colThreshold = Math.max(p75Gap * 2, 10);

        let line = tokens[0].text;
        for (let i = 1; i < tokens.length; i++) {
          const gap = tokens[i].x - (tokens[i - 1].x + tokens[i - 1].width);
          if (gap >= colThreshold) {
            line += ' | ' + tokens[i].text;
          } else {
            line += ' ' + tokens[i].text;
          }
        }

        const trimmed = line.trim();
        if (trimmed) allLines.push(trimmed);
      }
    }

    const result = allLines.join('\n');
    console.log(`  → pdfjs: ${result.length} chars, ${allLines.length} linhas`);
    return result;
  } catch (err) {
    console.error('  → pdfjs falhou:', err.message);
    return null;
  }
}

async function extractTextFallback(fileBuffer) {
  try {
    const pdfData = await pdf(fileBuffer);
    const text = (pdfData.text || '').trim();
    if (text.length >= 150) {
      console.log(`  → pdf-parse fallback: ${text.length} chars`);
      return text;
    }
  } catch (err) {
    console.error('  → pdf-parse falhou:', err.message);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTIMATIVA DE ITENS ESPERADOS
// ─────────────────────────────────────────────────────────────────────────────

function estimateExpectedItems(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // Conta linhas que começam com número sequencial seguido de conteúdo
  // Padrão: "1 ", "2 ", "10 ", " 1 ", etc. com conteúdo após
  let count = 0;
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^\s*(\d{1,3})\s+\S/);
    if (match) {
      const num = parseInt(match[1], 10);
      // Evita contar repetições do mesmo número (cabeçalho de página)
      if (!seen.has(num) && num >= 1 && num <= 999) {
        seen.add(num);
        count++;
      }
    }
  }
  console.log(`  → Estimativa de itens esperados: ${count}`);
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECÇÃO: PDF COM ESTRUTURA MULTI-LINHA
// ─────────────────────────────────────────────────────────────────────────────

function detectMultilineStructure(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let linesWithPipe = 0;
  let linesWithoutPipe = 0;
  let started = false;

  for (let i = 0; i < Math.min(100, lines.length); i++) {
    const line = lines[i];
    // FIX: threshold reduzido de 20 para 15 chars para ativar 'started'
    if (!started && line.length > 15) started = true;
    if (!started) continue;
    if (line.includes('|')) linesWithPipe++;
    else if (line.length > 10) linesWithoutPipe++;
  }

  const total = linesWithPipe + linesWithoutPipe;
  const isMultiline = total > 5 && (linesWithPipe / total) < 0.3;

  if (isMultiline) {
    console.log(
      `  → Estrutura multi-linha detectada (${linesWithPipe} com pipe, ${linesWithoutPipe} sem)`
    );
  }
  return isMultiline;
}

// ─────────────────────────────────────────────────────────────────────────────
// SKIP LINES E LIMPEZA
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_LINES = /^(total\s*geral|subtotal|frete\b|desconto\b|acrescimo|acréscimo|imposto\b|ipi\b|icms\b|icms\s*subs|validade\b|data\s*de\s|telefone\b|endere[cç]o|pedido\s*n[º°]|resumo\b|parcela\b|prazo\s*de|pagamento\b|emiss[aã]o|vencimento\b|condi[cç][oõ]es\s+de|observa[cç]|consultor\b|vendedor\b|representante\b|impresso\b|outros\b|volume\b|peso\b)/i;

function cleanProductName(raw) {
  if (!raw) return '';
  return raw
    // FIX 1: remove código numérico colado sem espaço (ex: "11764ANESTESICO")
    .replace(/^\d{4,8}(?=[A-Z])/i, '')
    // remove código numérico com espaço (ex: "11764 ANESTESICO")
    .replace(/^\d{4,8}\s+(?=[A-Z]{2})/i, '')
    // remove número sequencial de item (ex: "1 ANESTESICO")
    .replace(/^\d{1,3}\s+(?=[A-Z]{2})/i, '')
    // remove razão social no final
    .replace(/\s+(LTDA|S\/A|EIRELI|INDUSTRIA|COMERCIO|IMPORTA|BRASIL|DENTAL).+$/i, '')
    // remove unidade de medida isolada no final
    .replace(/\s+(UN|PC|CX|PCT|UND|UNID)\s*$/i, '')
    // FIX 5: remove número isolado no final (ex: "ENHANCE CHAMA CX. 0")
    .replace(/\s+\d{1,2}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tryParsePrice(str) {
  if (!str) return null;
  const cleaned = str.replace(/R\$\s*/g, '').trim();
  return parseBrazilianNumber(cleaned);
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECÇÃO DE CABEÇALHO E MAPEAMENTO DE COLUNAS
// ─────────────────────────────────────────────────────────────────────────────

const HEADER_KEYWORDS = {
  produto: [
    'descri', 'produto', 'material', 'especif', 'denominac',
    'mercadoria', 'servico', 'discrimin', 'nome'
  ],
  quantidade: [
    'qtd', 'qtde', 'quant', 'qty', 'un.', 'unid', 'amount'
  ],
  preco: [
    'vl total', 'vr total', 'v.total', 'valor total', 'preco total',
    'r$ total', 'total geral', 'v.unit', 'total'
  ],
  unitario: [
    'preco unit', 'valor unit', 'vl unit', 'p.unit',
    'unitario', 'unitário', 'preco un', 'pu', 'v.unit', 'pr.tab', 'unit'
  ]
};

function normalizeHeader(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesKeywords(colText, keywords) {
  const norm = normalizeHeader(colText);
  const sorted = [...keywords].sort((a, b) => b.length - a.length);
  return sorted.some(kw => norm.includes(kw));
}

function isHeaderLine(cols) {
  const numericCols = cols.filter(c => /^\d+([.,]\d+)?$/.test(c.trim())).length;
  return numericCols / cols.length < 0.5;
}

function detectColumnMap(text, hints = {}) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let li = 0; li < Math.min(80, lines.length); li++) {
    const line = lines[li];
    if (!line.includes('|')) continue;

    const cols = line.split('|').map(c => c.trim());
    if (cols.length < 3) continue;
    if (!isHeaderLine(cols)) continue;

    const map = { produtoIdx: -1, qtyIdx: -1, totalIdx: -1, unitIdx: -1 };

    // Passagem 1: hints com match exato
    cols.forEach((col, idx) => {
      const norm = normalizeHeader(col);
      if (hints.produto && map.produtoIdx === -1) {
        if (norm === normalizeHeader(hints.produto)) map.produtoIdx = idx;
      }
      if (hints.quantidade && map.qtyIdx === -1) {
        if (norm === normalizeHeader(hints.quantidade)) map.qtyIdx = idx;
      }
      if (hints.preco && map.totalIdx === -1) {
        if (norm === normalizeHeader(hints.preco)) map.totalIdx = idx;
      }
    });

    // Passagem 2: hints com includes
    cols.forEach((col, idx) => {
      const norm = normalizeHeader(col);
      if (hints.produto && map.produtoIdx === -1) {
        if (norm.includes(normalizeHeader(hints.produto))) map.produtoIdx = idx;
      }
      if (hints.quantidade && map.qtyIdx === -1) {
        if (norm.includes(normalizeHeader(hints.quantidade))) map.qtyIdx = idx;
      }
      if (hints.preco && map.totalIdx === -1) {
        if (norm.includes(normalizeHeader(hints.preco))) map.totalIdx = idx;
      }
    });

    // Passagem 3: keywords automáticas
    cols.forEach((col, idx) => {
      if (map.produtoIdx === -1 && matchesKeywords(col, HEADER_KEYWORDS.produto)) {
        map.produtoIdx = idx;
      } else if (map.qtyIdx === -1 && matchesKeywords(col, HEADER_KEYWORDS.quantidade)) {
        map.qtyIdx = idx;
      } else if (map.totalIdx === -1 && matchesKeywords(col, HEADER_KEYWORDS.preco)) {
        map.totalIdx = idx;
      } else if (map.unitIdx === -1 && matchesKeywords(col, HEADER_KEYWORDS.unitario)) {
        map.unitIdx = idx;
      }
    });

    if (map.produtoIdx < 0 || (map.totalIdx < 0 && map.unitIdx < 0)) continue;

    const usedIndices = [map.produtoIdx, map.qtyIdx, map.totalIdx, map.unitIdx]
      .filter(i => i >= 0);
    if (new Set(usedIndices).size !== usedIndices.length) {
      console.warn(`  → Conflito de índices na linha ${li}, ignorando...`);
      continue;
    }

    console.log(`  → Cabeçalho detectado na linha ${li}: "${line}"`);
    console.log(
      `  → Map: produto[${map.produtoIdx}] qty[${map.qtyIdx}] ` +
      `total[${map.totalIdx}] unit[${map.unitIdx}]`
    );
    return { ...map, headerLineIdx: li, totalCols: cols.length };
  }

  console.log('  → Sem cabeçalho detectado.');
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRATOR COM MAPA DE COLUNAS
// ─────────────────────────────────────────────────────────────────────────────

function extractItemsWithColMap(text, colMap) {
  if (!colMap || colMap.produtoIdx < 0) return [];

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  let passedHeader = false;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    if (!passedHeader) {
      if (li === colMap.headerLineIdx) passedHeader = true;
      continue;
    }

    if (!line.includes('|')) continue;
    if (SKIP_LINES.test(line)) continue;

    const cols = line.split('|').map(c => c.trim());
    const neededIndices = [
      colMap.produtoIdx, colMap.qtyIdx, colMap.totalIdx, colMap.unitIdx
    ].filter(i => i >= 0);

    if (!neededIndices.length) continue;
    const maxNeeded = Math.max(...neededIndices);
    if (cols.length <= maxNeeded) continue;

    let name = cols[colMap.produtoIdx] || '';
    name = cleanProductName(name);
    if (!name || name.length < 3) continue;
    if (SKIP_LINES.test(name)) continue;
    if (/^\d+$/.test(name)) continue;

    let qty = null;
    if (colMap.qtyIdx >= 0 && cols[colMap.qtyIdx]) {
      const n = parseBrazilianNumber(cols[colMap.qtyIdx]);
      if (n && n > 0 && n <= 9999) qty = n;
    }

    let totalPrice = null;
    if (colMap.totalIdx >= 0 && cols[colMap.totalIdx]) {
      const p = tryParsePrice(cols[colMap.totalIdx]);
      if (p && p > 0) totalPrice = p;
    }

    let unitPrice = null;
    if (colMap.unitIdx >= 0 && cols[colMap.unitIdx]) {
      const p = tryParsePrice(cols[colMap.unitIdx]);
      if (p && p > 0) unitPrice = p;
    }

    if (!totalPrice && unitPrice && qty && qty > 0) {
      totalPrice = roundMoney(unitPrice * qty);
    }
    if (!unitPrice && totalPrice && qty && qty > 0) {
      unitPrice = roundMoney(totalPrice / qty);
    }

    if (!qty && unitPrice && totalPrice && unitPrice > 0 &&
        totalPrice > 0 && unitPrice !== totalPrice) {
      for (let q = 1; q <= 500; q++) {
        if (Math.abs(roundMoney(q * unitPrice) - totalPrice) / totalPrice <= 0.02) {
          qty = q; break;
        }
      }
    }

    if (!qty || qty <= 0) qty = 1;
    if (!totalPrice && unitPrice) totalPrice = roundMoney(unitPrice * qty);
    if (!totalPrice || totalPrice <= 0) continue;
    if (!unitPrice && qty > 0) unitPrice = roundMoney(totalPrice / qty);

    items.push({
      name,
      qty,
      unitPrice: roundMoney(unitPrice || totalPrice / qty),
      totalPrice: roundMoney(totalPrice)
    });
  }

  const seen = new Set();
  const unique = items.filter(item => {
    const key = `${item.name.toLowerCase()}__${item.totalPrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  → extrator com mapa de colunas: ${unique.length} itens`);
  return unique;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRATOR GENÉRICO
// ─────────────────────────────────────────────────────────────────────────────

function extractItemsFromStructuredText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    if (SKIP_LINES.test(line)) continue;
    if (line.length < 5) continue;
    if (!line.includes('|')) continue;

    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 3) continue;

    const prices = [];
    const textCols = [];

    for (const col of cols) {
      const price = tryParsePrice(col);
      if (price !== null && price > 0 && /[\d.,]{3,}/.test(col)) {
        prices.push(price);
      } else {
        textCols.push(col);
      }
    }

    if (prices.length < 1) continue;

    let name = textCols.find(c => c.length > 4 && !/^\d+$/.test(c));
    if (!name) continue;
    name = cleanProductName(name);
    if (!name || name.length < 4) continue;
    if (SKIP_LINES.test(name)) continue;

    let qty = null;
    for (const col of cols) {
      const trimmed = col.trim();
      if (!/^\d{1,4}([.,]\d+)?$/.test(trimmed)) continue;
      const n = parseBrazilianNumber(trimmed);
      if (n && n > 0 && n <= 9999 && Number.isInteger(n)) { qty = n; break; }
    }

    const totalPrice = prices[prices.length - 1];
    const unitPrice  = prices[0];

    if (qty && qty > 0) {
      const calc = roundMoney(qty * unitPrice);
      if (totalPrice > 0 && Math.abs(calc - totalPrice) / totalPrice <= 0.05) {
        items.push({
          name, qty,
          unitPrice: roundMoney(unitPrice),
          totalPrice: roundMoney(totalPrice)
        });
        continue;
      }
      const calc2 = roundMoney(qty * totalPrice);
      if (unitPrice > 0 && Math.abs(calc2 - unitPrice) / unitPrice <= 0.05) {
        items.push({
          name, qty,
          unitPrice: roundMoney(totalPrice),
          totalPrice: roundMoney(unitPrice)
        });
        continue;
      }
    }

    let found = false;
    for (const [u, t] of [[unitPrice, totalPrice], [totalPrice, unitPrice]]) {
      if (u <= 0 || t <= 0 || u === t) continue;
      for (let q = 1; q <= 500; q++) {
        if (t > 0 && Math.abs(roundMoney(q * u) - t) / t <= 0.02) {
          items.push({ name, qty: q, unitPrice: roundMoney(u), totalPrice: roundMoney(t) });
          found = true; break;
        }
      }
      if (found) break;
    }

    if (!found && prices.length === 1) {
      items.push({
        name,
        qty: qty || 1,
        unitPrice: roundMoney(prices[0]),
        totalPrice: roundMoney(prices[0] * (qty || 1))
      });
    }
  }

  const seen = new Set();
  const unique = items.filter(item => {
    const key = `${item.name.toLowerCase()}__${item.totalPrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  → extrator genérico: ${unique.length} itens`);
  return unique;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRAÇÃO VIA IA
// ─────────────────────────────────────────────────────────────────────────────

async function extractWithAI(text, cotacaoIndex, hints = {}) {
  console.log(`  → Chamando IA para extração (cotação ${cotacaoIndex + 1})...`);

  const colInstructions = [];
  if (hints.produto)    colInstructions.push(`- Coluna de produto: "${hints.produto}"`);
  if (hints.quantidade) colInstructions.push(`- Coluna de quantidade: "${hints.quantidade}"`);
  if (hints.preco)      colInstructions.push(`- Coluna de preço total: "${hints.preco}"`);

  const colHint = colInstructions.length > 0
    ? `\nInformações sobre as colunas:\n${colInstructions.join('\n')}`
    : '';

  const systemPrompt = `Você extrai itens de cotações odontológicas e responde SOMENTE JSON válido:
{"items":[{"name":"NOME DO PRODUTO","qty":1,"totalPrice":24.68}]}

Regras absolutas:
- name: nome limpo do produto, sem código numérico inicial, sem razão social, sem LTDA/S.A
- qty: quantidade inteira. Formato "3,000" = 3 unidades, "60,000" = 60 unidades
- totalPrice: valor TOTAL do item (qty × preço unitário). Sempre o maior valor associado ao item
- Ignore completamente: ICMS, ST, IPI, frete, totais gerais, cabeçalhos, rodapés, observações, URLs, datas, linhas "Lote:"

Estrutura SEM colunas (sem |):
  Cada item segue o padrão: número-item quantidade código nome preço-unitário preço-total
  - O valor total pode estar na linha IMEDIATAMENTE APÓS os dados do item
  - Se uma linha após o nome contém apenas texto sem dados numéricos de preço
    (ex: "1:100 - DFL", "250ML", "COM 40"), ela é CONTINUAÇÃO do nome — junte ao nome anterior
  - Se uma linha contém unidade de medida junto ao nome (ex: "FRASCO 250ML"), mantenha no nome
  - Ignore linhas que começam com "Lote:", CFOP (4 dígitos isolados), códigos auxiliares`;

  const userPrompt = `Extraia TODOS os produtos desta cotação odontológica.${colHint}

Se houver | no texto, cada | separa uma coluna.
Se NÃO houver |, interprete linha a linha conforme as regras acima.

Cotação ${cotacaoIndex + 1}:
${text.slice(0, 18000)}`;

  try {
    const result = await callAI(systemPrompt, userPrompt);
    const items = Array.isArray(result?.items) ? result.items : [];
    const fixed = items.map(item => {
      const name = cleanProductName(safeString(item?.name));
      const qty  = parseBrazilianNumber(item?.qty) || 1;
      const totalPrice = parseBrazilianNumber(item?.totalPrice);
      if (!name || name.length < 3 || !totalPrice || totalPrice <= 0 || qty <= 0) return null;
      return {
        name,
        qty: Math.round(qty),
        totalPrice: roundMoney(totalPrice)
      };
    }).filter(Boolean);
    console.log(`  → IA extraiu ${fixed.length} itens`);
    return fixed;
  } catch (err) {
    console.error('  → IA extração falhou:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SANITIZE FINAL
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeItems(items) {
  const sanitized = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const name = safeString(item?.name);
    const qty  = parseBrazilianNumber(item?.qty);
    const totalPrice = parseBrazilianNumber(item?.totalPrice);

    if (!name || name.length < 3) continue;
    if (!qty || qty <= 0) continue;
    if (!totalPrice || totalPrice <= 0) continue;
    if (/\b(total\s*geral|subtotal|frete|imposto|ipi\b|icms\b|desconto|acrescimo|acréscimo)\b/i
      .test(name)) continue;
    if (/^\d+$/.test(name)) continue;

    const key = `${name.toLowerCase()}__${totalPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sanitized.push({
      name,
      qty: Math.round(qty),
      totalPrice: roundMoney(totalPrice)
    });
  }

  return sanitized;
}

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE PRINCIPAL DE EXTRAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

async function extractItemsFromPDF(fileBuffer, cotacaoIndex, columnHints = {}) {
  // 1. Extrai texto com pdfjs
  let text = await extractTextWithPdfjs(fileBuffer);

  // 2. Fallback para pdf-parse
  if (!text || text.length < 150) {
    console.warn('  → pdfjs insuficiente, tentando pdf-parse...');
    text = await extractTextFallback(fileBuffer);
  }

  if (!text || text.length < 150) {
    console.warn('  → Texto insuficiente, indo para IA...');
    const aiItems = await extractWithAI('', cotacaoIndex, columnHints);
    return { items: sanitizeItems(aiItems), method: 'ai-only' };
  }

  console.log(`  → Primeiras linhas:\n${text.split('\n').slice(0, 10).join('\n')}\n  ...`);

  // 3. Estima quantos itens o PDF deve ter
  const expectedCount = estimateExpectedItems(text);

  // 4. FIX: se há hints, tenta colmap PRIMEIRO antes de verificar multi-linha
  const hasHints = !!(columnHints.produto || columnHints.quantidade || columnHints.preco);
  if (hasHints) {
    const colMap = detectColumnMap(text, columnHints);
    if (colMap) {
      const localItems = extractItemsWithColMap(text, colMap);
      const sanitized = sanitizeItems(localItems);

      // FIX threshold: verifica cobertura mínima de 60%
      const coverage = expectedCount > 0 ? sanitized.length / expectedCount : 1;
      console.log(
        `  → Cobertura local: ${sanitized.length}/${expectedCount} = ${(coverage * 100).toFixed(0)}%`
      );

      if (sanitized.length >= 3 && coverage >= 0.6) {
        console.log(`  ✅ Extração local com hints: ${sanitized.length} itens`);
        return { items: sanitized, method: 'local-colmap' };
      }

      console.log(
        `  → Cobertura insuficiente (${(coverage * 100).toFixed(0)}% < 60%), chamando IA...`
      );
    }
  }

  // 5. Detecta multi-linha (para PDFs sem colmap ou cobertura insuficiente)
  const isMultiline = detectMultilineStructure(text);
  if (isMultiline) {
    console.log('  → PDF multi-linha: enviando direto para IA...');
    const aiItems = await extractWithAI(text, cotacaoIndex, columnHints);
    const sanitized = sanitizeItems(aiItems);
    return {
      items: sanitized,
      method: sanitized.length > 0 ? 'ai-multiline' : 'ai-only'
    };
  }

  // 6. Sem hints ou colmap não encontrado: tenta colmap automático e genérico
  const colMap = detectColumnMap(text, columnHints);
  const localItems = colMap
    ? extractItemsWithColMap(text, colMap)
    : extractItemsFromStructuredText(text);
  const sanitizedLocal = sanitizeItems(localItems);

  // Verifica cobertura também aqui
  const coverage = expectedCount > 0 ? sanitizedLocal.length / expectedCount : 1;
  console.log(
    `  → Cobertura local: ${sanitizedLocal.length}/${expectedCount} = ${(coverage * 100).toFixed(0)}%`
  );

  if (sanitizedLocal.length >= 3 && coverage >= 0.6) {
    console.log(`  ✅ Extração local: ${sanitizedLocal.length} itens`);
    return {
      items: sanitizedLocal,
      method: colMap ? 'local-colmap' : 'local-generic'
    };
  }

  // 7. Fallback para IA
  console.log(
    `  → Local insuficiente (${sanitizedLocal.length} itens, ${(coverage * 100).toFixed(0)}% cobertura), chamando IA...`
  );
  const aiItems = await extractWithAI(text, cotacaoIndex, columnHints);
  const sanitizedAI = sanitizeItems(aiItems);
  const combined = sanitizeItems([...sanitizedLocal, ...sanitizedAI]);

  console.log(
    `  → Final: ${combined.length} itens (local: ${sanitizedLocal.length} + IA: ${sanitizedAI.length})`
  );
  return {
    items: combined,
    method: sanitizedAI.length > 0 ? 'local+ai' : 'local'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGRUPAMENTO
// ─────────────────────────────────────────────────────────────────────────────

function applyDomainAliases(value) {
  return value
    .replace(/\bROLO\b/g, 'BOBINA')
    .replace(/\bESTERILIZACAO\b/g, 'SELADORA')
    .replace(/\bTEMPORARIO\b/g, 'PROVISORIO')
    .replace(/\bRESTAURADOR\b/g, 'CIMENTO')
    .replace(/\bOBTURADOR\b/g, 'CIMENTO')
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

function normalizeProductName(name) {
  return applyDomainAliases(
    safeString(name)
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
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
      .replace(/(\d+)\s*(MG|ML|MCG|UI|G|KG|L|MM|CM|%)\b/g, '$1$2')
      .replace(/(\d+)\s*X\s*(\d+)\b/g, '$1X$2')
      .replace(/(\d+)\s*\/\s*(\d+)\b/g, '$1/$2')
      .replace(/[^\w\s%/.-]/g, ' ')
      .replace(
        /\b(DE|DA|DO|DAS|DOS|E|EM|PARA|POR|COM|SEM|TIPO|MODELO|ITEM|PRODUTO|MARCA|REF|REFERENCIA|N|NRO|NUMERO)\b/g,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function tokenizeName(name) {
  return normalizeProductName(name).split(' ').filter(Boolean);
}

function isMeasureToken(token) {
  return /^(\d+(?:[.,]\d+)?)(MG|G|KG|ML|L|MCG|UI|MM|CM|%)$/.test(token);
}

function getStrongCommercialTokens(name) {
  const normalized = normalizeProductName(name);
  return STRONG_COMMERCIAL_TOKENS.filter(token => normalized.includes(token));
}

function getCriticalTokens(name) {
  const tokens = tokenizeName(name);
  return tokens.filter(token =>
    isMeasureToken(token) ||
    /^[A-Z]{2,}\d+[A-Z0-9-]*$/.test(token) ||
    /^\d+\/\d+$/.test(token) ||
    /^\d+X\d+$/.test(token)
  );
}

function hasCriticalConflict(nameA, nameB) {
  const criticalA = getCriticalTokens(nameA);
  const criticalB = getCriticalTokens(nameB);
  if (criticalA.length === 0 || criticalB.length === 0) return false;
  const measureA = criticalA.filter(isMeasureToken);
  const measureB = criticalB.filter(isMeasureToken);
  if (measureA.length > 0 && measureB.length > 0) {
    if (!measureA.some(token => measureB.includes(token))) return true;
  }
  const strictA = criticalA.filter(token => !isMeasureToken(token));
  const strictB = criticalB.filter(token => !isMeasureToken(token));
  if (strictA.length > 0 && strictB.length > 0) {
    if (!strictA.some(token => strictB.includes(token))) return true;
  }
  return false;
}

function getRelevantTokens(name) {
  return tokenizeName(name).filter(token => token.length > 1 && !/^\d+$/.test(token));
}

function tokenSimilarity(nameA, nameB) {
  const tokensA = [...new Set(getRelevantTokens(nameA))];
  const tokensB = [...new Set(getRelevantTokens(nameB))];
  if (!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  const intersection = tokensA.filter(t => setB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

function containsCoreOfOther(nameA, nameB) {
  const tokensA = getRelevantTokens(nameA).filter(t => t.length >= 3);
  const tokensB = getRelevantTokens(nameB).filter(t => t.length >= 3);
  if (!tokensA.length || !tokensB.length) return false;
  const shortSet = tokensA.length <= tokensB.length ? tokensA : tokensB;
  const longTokens = new Set(tokensA.length > tokensB.length ? tokensA : tokensB);
  return shortSet.filter(t => longTokens.has(t)).length / shortSet.length >= 0.75;
}

function sameFirstStrongTokens(nameA, nameB) {
  const tokensA = getRelevantTokens(nameA).filter(t => t.length >= 4);
  const tokensB = getRelevantTokens(nameB).filter(t => t.length >= 4);
  if (!tokensA.length || !tokensB.length) return false;
  return tokensA[0] === tokensB[0] ||
    (tokensA[1] && tokensB[1] && tokensA[1] === tokensB[1]);
}

function boostForStrongCommercialMatch(nameA, nameB) {
  const a = getStrongCommercialTokens(nameA);
  const b = getStrongCommercialTokens(nameB);
  if (!a.length || !b.length) return 0;
  const overlap = a.filter(t => b.includes(t)).length;
  if (overlap >= 3) return 0.24;
  if (overlap === 2) return 0.18;
  if (overlap === 1) return 0.1;
  return 0;
}

function similarityScore(nameA, nameB) {
  if (!nameA || !nameB) return 0;
  const normA = normalizeProductName(nameA);
  const normB = normalizeProductName(nameB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (hasCriticalConflict(nameA, nameB)) return 0;
  let score = tokenSimilarity(nameA, nameB);
  if (containsCoreOfOther(nameA, nameB)) score += 0.16;
  if (sameFirstStrongTokens(nameA, nameB)) score += 0.08;
  score += boostForStrongCommercialMatch(nameA, nameB);
  return Math.min(score, 1);
}

function averageSimilarityToGroup(item, group) {
  if (!group.length) return 0;
  const scores = group.map(g => similarityScore(item.name, g.name));
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const max = Math.max(...scores);
  return avg * 0.6 + max * 0.4;
}

function chooseCanonicalName(items) {
  const sorted = [...items].sort((a, b) => {
    const scoreDiff = (b._score || 0) - (a._score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b.name || '').length - String(a.name || '').length;
  });
  return sorted[0]?.name || 'Produto';
}

function dedupeAndLimitGroup(items, numCotacoes) {
  const byCotacao = new Map();
  const overflow = [];
  for (const item of items) {
    const arr = byCotacao.get(item.cotacaoIdx) || [];
    arr.push(item);
    byCotacao.set(item.cotacaoIdx, arr);
  }
  const kept = [];
  for (const [, arr] of byCotacao.entries()) {
    const sorted = [...arr].sort((a, b) => (b._score || 0) - (a._score || 0));
    kept.push(sorted[0]);
    if (sorted.length > 1) overflow.push(...sorted.slice(1));
  }
  if (kept.length > numCotacoes) {
    const sorted = [...kept].sort((a, b) => (b._score || 0) - (a._score || 0));
    overflow.push(...sorted.slice(numCotacoes));
    return { kept: sorted.slice(0, numCotacoes), overflow };
  }
  return { kept, overflow };
}

function redistributeOverflow(groups, overflow, numCotacoes) {
  const leftovers = [];
  for (const item of overflow) {
    let bestGroupIdx = -1, bestScore = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.some(g => g.cotacaoIdx === item.cotacaoIdx)) continue;
      if (group.length >= numCotacoes) continue;
      const score = averageSimilarityToGroup(item, group);
      if (score > bestScore) { bestScore = score; bestGroupIdx = i; }
    }
    if (bestGroupIdx >= 0 && bestScore >= 0.5) {
      item._score = bestScore;
      groups[bestGroupIdx].push(item);
    } else {
      leftovers.push(item);
    }
  }
  leftovers.forEach(item => groups.push([{ ...item, _score: 1 }]));
  return groups;
}

function buildGroupsLocally(items, numCotacoes) {
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
      const score = similarityScore(base.name, items[j].name);
      if (score >= 0.44) candidates.push({ idx: j, item: { ...items[j], _score: score }, score });
    }

    candidates.sort((a, b) => b.score - a.score).forEach(({ idx, item }) => {
      if (group.some(g => g.cotacaoIdx === item.cotacaoIdx)) return;
      if (group.length >= numCotacoes) return;
      const scoreToGroup = averageSimilarityToGroup(item, group);
      if (scoreToGroup >= 0.46) {
        item._score = scoreToGroup;
        group.push(item);
        used.add(idx);
      }
    });

    rawGroups.push(group);
  }

  let finalGroups = [], overflow = [];
  for (const group of rawGroups) {
    const canonical = chooseCanonicalName(group);
    const scoredItems = group.map(item => ({
      ...item,
      _score: similarityScore(item.name, canonical) || item._score || 0.5
    }));
    const constrained = dedupeAndLimitGroup(scoredItems, numCotacoes);
    if (constrained.kept.length > 0) finalGroups.push(constrained.kept);
    overflow.push(...constrained.overflow);
  }

  finalGroups = finalGroups.filter(g => g.length > 0);
  return redistributeOverflow(finalGroups, overflow, numCotacoes);
}

async function resolveAmbiguousPairsWithAI(candidateGroups, pairs) {
  if (!pairs.length) return [];
  const limitedGroups = candidateGroups.slice(0, 60);
  const valid = new Set(limitedGroups.map(g => g.localIdx));
  const filteredPairs = pairs.filter(([a, b]) => valid.has(a) && valid.has(b));
  if (!filteredPairs.length) return [];

  const pairLines = filteredPairs.map(([a, b]) => {
    const ga = limitedGroups.find(g => g.localIdx === a);
    const gb = limitedGroups.find(g => g.localIdx === b);
    if (!ga || !gb) return null;
    return (
      `[${limitedGroups.indexOf(ga)},${limitedGroups.indexOf(gb)}]` +
      ` "${ga.name}" vs "${gb.name}"`
    );
  }).filter(Boolean);

  if (!pairLines.length) return [];

  const systemPrompt = `Você é especialista em materiais odontológicos.
Decida se pares de descrições representam o MESMO produto.
Responda SOMENTE JSON válido: {"merge":[[0,1],[2,3]]}`;

  const userPrompt = `Analise os pares e agrupe os que são o mesmo produto.
NÃO agrupe se houver diferença de dosagem, concentração, volume ou tamanho.

Pares:
${pairLines.join('\n')}

Produtos:
${limitedGroups.map((g, i) => `${i}: "${g.name}"`).join('\n')}

Responda: {"merge":[[0,1]]} ou {"merge":[]}`;

  const result = await callAI(systemPrompt, userPrompt);
  const merges = Array.isArray(result?.merge) ? result.merge : [];
  return merges
    .map(group => group.map(i => limitedGroups[i]?.localIdx).filter(x => x !== undefined))
    .filter(group => group.length >= 2);
}

async function groupItemsRich(items, numCotacoes) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (items.length === 1) {
    return [{
      indices: [0],
      canonicalName: items[0]?.name || 'Produto',
      reason: 'único'
    }];
  }

  const localGroups = buildGroupsLocally(
    items.map((item, index) => ({
      index,
      name: item.name,
      cotacaoIdx: item.cotacaoIdx,
      cotacaoName: item.cotacaoName
    })),
    numCotacoes
  );

  const candidateGroups = localGroups.map((group, idx) => ({
    localIdx: idx,
    items: group,
    name: chooseCanonicalName(group)
  }));

  const ambiguousPairs = [];
  for (let i = 0; i < candidateGroups.length; i++) {
    for (let j = i + 1; j < candidateGroups.length; j++) {
      const score = similarityScore(candidateGroups[i].name, candidateGroups[j].name);
      if (!hasCriticalConflict(candidateGroups[i].name, candidateGroups[j].name) &&
          score >= 0.24) {
        ambiguousPairs.push([i, j]);
      }
    }
  }

  let mergedLocalGroups = candidateGroups.map(g => ({ items: [...g.items], name: g.name }));

  try {
    const aiMerges = await resolveAmbiguousPairsWithAI(candidateGroups, ambiguousPairs);
    const merged = new Set();
    for (const mergeGroup of aiMerges) {
      if (mergeGroup.length < 2) continue;
      const [first, ...rest] = mergeGroup;
      if (merged.has(first)) continue;
      for (const other of rest) {
        if (merged.has(other) || other === first) continue;
        mergedLocalGroups[first].items.push(...mergedLocalGroups[other].items);
        mergedLocalGroups[first].name = chooseCanonicalName(mergedLocalGroups[first].items);
        merged.add(other);
      }
    }
    mergedLocalGroups = mergedLocalGroups.filter((_, idx) => !merged.has(idx));
  } catch (err) {
    console.warn('[Agrupamento] IA falhou, mantendo local:', err.message);
  }

  let finalGroups = [], overflow = [];
  for (const group of mergedLocalGroups) {
    const canonical = chooseCanonicalName(group.items);
    const scoredItems = group.items.map(item => ({
      ...item,
      _score: similarityScore(item.name, canonical) || 0.5
    }));
    const constrained = dedupeAndLimitGroup(scoredItems, numCotacoes);
    if (constrained.kept.length > 0) finalGroups.push(constrained.kept);
    overflow.push(...constrained.overflow);
  }

  finalGroups = redistributeOverflow(finalGroups, overflow, numCotacoes);

  return finalGroups.map(group => ({
    indices: group.map(item => item.index),
    canonicalName: chooseCanonicalName(group),
    reason: group.length > 1 ? 'agrupado' : 'único'
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/extract-pdfs', upload.array('pdfs', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Envie pelo menos 2 arquivos PDF.'
      });
    }

    const results = [];

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const supplierName = req.body?.[`supplierName_${i}`] || `Cotação ${i + 1}`;

      const columnHints = {
        produto:    (req.body?.[`colProduto_${i}`]    || '').trim(),
        quantidade: (req.body?.[`colQuantidade_${i}`] || '').trim(),
        preco:      (req.body?.[`colPreco_${i}`]      || '').trim()
      };

      console.log(`\n📄 [${i + 1}/${req.files.length}]: ${file.originalname} → "${supplierName}"`);
      if (columnHints.produto || columnHints.quantidade || columnHints.preco) {
        console.log(
          `  → Hints: produto="${columnHints.produto}" ` +
          `qty="${columnHints.quantidade}" ` +
          `preço="${columnHints.preco}"`
        );
      }

      try {
        const extracted = await extractItemsFromPDF(file.buffer, i, columnHints);
        console.log(
          `✅ ${file.originalname}: ${extracted.items?.length || 0} itens via ${extracted.method}`
        );
        results.push({
          cotacaoName: supplierName,
          originalName: file.originalname,
          items: Array.isArray(extracted.items) ? extracted.items : [],
          method: extracted.method
        });
      } catch (err) {
        console.error(`❌ Erro ao processar ${file.originalname}:`, err);
        results.push({
          cotacaoName: supplierName,
          originalName: file.originalname,
          items: [],
          error: err?.message || 'Erro ao processar este PDF.'
        });
      }

      // Sleep entre arquivos se usou IA e não é o último
      if (i < req.files.length - 1) {
        const usedAI = results[results.length - 1]?.method?.includes('ai');
        if (usedAI) await sleep(2000);
      }
    }

    return res.json({ success: true, data: results });
  } catch (error) {
    console.error('Erro geral:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro interno.'
    });
  }
});

app.post('/api/group-items', async (req, res) => {
  try {
    const items = req.body?.items;
    const numCotacoes = Number(req.body?.numCotacoes) || 1;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Lista de itens inválida.' });
    }

    const normalizedItems = items
      .map((item, index) => ({
        index,
        name: safeString(item?.name),
        cotacaoIdx: Number(item?.cotacaoIdx),
        cotacaoName: safeString(item?.cotacaoName) ||
          `Cotação ${(Number(item?.cotacaoIdx) || 0) + 1}`
      }))
      .filter(item => item.name && Number.isInteger(item.cotacaoIdx));

    if (!normalizedItems.length) {
      return res.status(400).json({ success: false, error: 'Nenhum item válido.' });
    }

    let groups;
    try {
      groups = await groupItemsRich(normalizedItems, Math.max(1, numCotacoes));
    } catch (err) {
      console.warn('[Agrupamento] Falha, usando fallback:', err.message);
      const fallback = buildGroupsLocally(normalizedItems, Math.max(1, numCotacoes));
      groups = fallback.map(group => ({
        indices: group.map(item => item.index),
        canonicalName: chooseCanonicalName(group),
        reason: 'fallback local'
      }));
    }

    return res.json({ success: true, groups });
  } catch (error) {
    console.error('Erro no agrupamento:', error);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    return res.json({
      success: true,
      groups: items.map((item, i) => ({
        indices: [i],
        canonicalName: safeString(item?.name) || `Produto ${i + 1}`,
        reason: 'fallback'
      }))
    });
  }
});

app.post('/api/gemini-group', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const numCotacoes = Number(req.body?.numCotacoes) || 1;

    if (!items.length) return res.json({ success: true, groups: [] });

    const normalizedItems = items.map((item, index) => ({
      index,
      name: safeString(item?.name),
      cotacaoIdx: Number(item?.cotacaoIdx),
      cotacaoName: safeString(item?.cotacaoName) ||
        `Cotação ${(Number(item?.cotacaoIdx) || 0) + 1}`
    }));

    const groups = await groupItemsRich(normalizedItems, Math.max(1, numCotacoes));
    return res.json({ success: true, groups });
  } catch (err) {
    console.error('Erro gemini-group:', err);
    return res.json({ success: false, error: err.message });
  }
});

app.get('/api/history', (req, res) => {
  res.json({ success: true, history: readHistory() });
});

app.post('/api/history', (req, res) => {
  try {
    const { entry } = req.body;
    if (!entry) return res.status(400).json({ success: false, error: 'Entry inválida.' });
    const history = readHistory();
    const newHistory = [
      { ...entry, id: crypto.randomUUID(), savedAt: new Date().toISOString() },
      ...history
    ].slice(0, 20);
    writeHistory(newHistory);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/history/:id', (req, res) => {
  try {
    const history = readHistory();
    writeHistory(history.filter(h => h.id !== req.params.id));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/history', (req, res) => {
  try {
    writeHistory([]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    groqConfigured: !!process.env.GROQ_API_KEY,
    groq2Configured: !!process.env.GROQ_API_KEY_2,
    claudeConfigured: !!process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    claudeModel: CLAUDE_MODEL
  });
});

app.use((err, req, res, next) => {
  console.error('💥 Erro:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err?.message || 'Erro interno.' });
});

process.on('uncaughtException', err => console.error('💥 uncaughtException:', err));
process.on('unhandledRejection', reason => console.error('💥 unhandledRejection:', reason));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`🔑 Groq chave 1: ${process.env.GROQ_API_KEY ? 'OK' : '⚠️ NÃO CONFIGURADO'}`);
  console.log(`🔑 Groq chave 2: ${process.env.GROQ_API_KEY_2 ? 'OK' : '⚠️ NÃO CONFIGURADO'}`);
  console.log(`🔑 Claude: ${process.env.ANTHROPIC_API_KEY ? 'OK' : '⚠️ NÃO CONFIGURADO'}`);
  console.log(`🤖 Cadeia: ${MODEL} (Groq#1 → Groq#2) → ${CLAUDE_MODEL} (Claude)`);
});