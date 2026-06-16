# CotaCompara

Sistema de comparação de cotações comerciais com extração automática via IA.

## Como funciona

1. **Upload** — Envie de 2 a 10 PDFs de cotações (normais ou escaneados)
2. **Revisão** — A IA extrai e agrupa os produtos automaticamente. Edite o que precisar
3. **Resultado** — Compare preços, veja economias e exporte em PDF ou Excel

## Tecnologias

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **IA:** Google Gemini 2.5 Flash Lite (extração, agrupamento semântico e leitura de PDFs escaneados)
- **PDF escaneado:** Gemini Vision (fallback automático quando o PDF não tem texto)

## Configuração

### 1. Clone o repositório

```bash
git clone <url-do-repositorio>