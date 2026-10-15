# CotaCompara

Sistema de comparação de cotações comerciais com extração automática via IA.

## Como funciona

1. **Upload** — Envie de 2 a 10 PDFs de cotações (normais ou escaneados)
2. **Revisão** — A IA extrai e agrupa os produtos automaticamente. Edite o que precisar
3. **Resultado** — Compare preços, veja economias e exporte em PDF ou Excel

## Tecnologias

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **IA principal:** Google Gemini (plano gratuito) — lê o PDF direto, inclusive escaneado, e agrupa os produtos equivalentes
- **IA reserva:** Groq (`openai/gpt-oss-120b`) — usada quando o Gemini atinge o limite gratuito ou fica indisponível; trabalha com o texto extraído do PDF
- **Opcional:** Claude (Anthropic) como última reserva, se `ANTHROPIC_API_KEY` estiver definida

## Configuração

### 1. Clone o repositório

```bash
git clone https://github.com/RafaelCardoso25/comparacao-system.git
cd comparacao-system
```

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Preencha o `.env`:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GEMINI_API_KEY` | Recomendado | Chave gratuita do [Google AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | Não | Modelo principal (padrão `gemini-3.6-flash`) |
| `GEMINI_FALLBACK_MODEL` | Não | Modelo usado se o principal estourar o limite (padrão `gemini-3.5-flash-lite`) |
| `GROQ_API_KEY` | Recomendado | Chave do [Groq](https://console.groq.com/keys), usada como reserva |
| `GROQ_API_KEY_2` | Não | Segunda chave do Groq |
| `GROQ_MODEL` | Não | Modelo do Groq (padrão `openai/gpt-oss-120b`) |
| `ANTHROPIC_API_KEY` | Não | Claude como última reserva (pago) |

É preciso pelo menos uma IA configurada. Sem o Gemini, PDFs escaneados não são lidos.

```bash
npm run dev
```

### 3. Frontend

```bash
cd frontend
npm install
```

Crie `frontend/.env` com a URL do backend:

```
VITE_API_URL=http://localhost:3001
```

```bash
npm run dev
```

## Ordem de extração de cada PDF

1. Gemini lê o PDF direto (texto + layout + imagem da página)
2. Se o Gemini falhar: o texto é extraído localmente e lido por colunas
3. Se a leitura local cobrir poucos itens: a IA de texto completa (Gemini → Groq → Claude)

## Observação sobre privacidade

No plano gratuito, o Google pode usar o conteúdo enviado para melhorar os modelos dele. Se as cotações tiverem dados sensíveis, considere ativar o faturamento no projeto do AI Studio (os dados deixam de ser usados para treino).
