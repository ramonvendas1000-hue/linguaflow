# CLAUDE.md — Diretrizes de Animação com Framer Motion

## Regra geral de animações

Toda animação de UI deve usar **transições do tipo `spring`** como padrão. Nunca use `tween` para interações diretas do usuário (hover, tap, drag). Reserve `tween` apenas para animações de progresso ou loading bars.

---

## Configurações de spring padronizadas

Use sempre uma dessas três predefinições. Não invente valores arbitrários de `stiffness`/`damping` fora dessas faixas.

```ts
// tokens de spring — importe de lib/motion.ts
export const spring = {
  snappy:  { type: "spring", stiffness: 500, damping: 30, mass: 1 },   // botões, chips, toggles
  smooth:  { type: "spring", stiffness: 300, damping: 25, mass: 1 },   // cards, modais, dropdowns
  gentle:  { type: "spring", stiffness: 150, damping: 20, mass: 1.2 }, // page transitions, hero sections
} as const
```

Crie o arquivo `lib/motion.ts` (ou `utils/motion.ts`) e exporte `spring` + todas as variantes abaixo. **Nunca** declare `transition` inline nos componentes — sempre referencie os tokens.

---

## Variantes organizadas

### Fade + slide (entrada de elementos)

```ts
export const fadeUp = {
  hidden:  { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: spring.smooth },
  exit:    { opacity: 0, y: -8, transition: spring.snappy },
}

export const fadeIn = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: spring.smooth },
  exit:    { opacity: 0,  transition: spring.snappy },
}
```

### Scale (pop — botões, badges, ícones)

```ts
export const pop = {
  rest:    { scale: 1 },
  hover:   { scale: 1.05, transition: spring.snappy },
  tap:     { scale: 0.95, transition: spring.snappy },
}
```

### Slide lateral (drawers, sidebars)

```ts
export const slideRight = {
  hidden:  { x: "-100%", opacity: 0 },
  visible: { x: 0,       opacity: 1, transition: spring.smooth },
  exit:    { x: "-100%", opacity: 0, transition: spring.snappy },
}

export const slideLeft = {
  hidden:  { x: "100%",  opacity: 0 },
  visible: { x: 0,       opacity: 1, transition: spring.smooth },
  exit:    { x: "100%",  opacity: 0, transition: spring.snappy },
}
```

### Listas com stagger (filhos animam em sequência)

```ts
export const staggerContainer = {
  hidden:  {},
  visible: {
    transition: { staggerChildren: 0.07, delayChildren: 0.1 },
  },
}

// use `fadeUp` ou `fadeIn` nos filhos
```

### Modal / overlay

```ts
export const backdrop = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } }, // tween OK aqui (overlay plano)
  exit:    { opacity: 0, transition: { duration: 0.15 } },
}

export const modal = {
  hidden:  { opacity: 0, scale: 0.95, y: 12 },
  visible: { opacity: 1, scale: 1,    y: 0, transition: spring.smooth },
  exit:    { opacity: 0, scale: 0.97, y: 6, transition: spring.snappy },
}
```

---

## Como usar nos componentes

```tsx
import { motion, AnimatePresence } from "framer-motion"
import { fadeUp, staggerContainer, pop, spring } from "@/lib/motion"

// Entrada simples
<motion.div variants={fadeUp} initial="hidden" animate="visible" exit="exit">
  Conteúdo
</motion.div>

// Lista com stagger
<motion.ul variants={staggerContainer} initial="hidden" animate="visible">
  {items.map(item => (
    <motion.li key={item.id} variants={fadeUp}>
      {item.label}
    </motion.li>
  ))}
</motion.ul>

// Botão com pop
<motion.button variants={pop} initial="rest" whileHover="hover" whileTap="tap">
  Clique aqui
</motion.button>

// Presença condicional (mount/unmount)
<AnimatePresence mode="wait">
  {isOpen && (
    <motion.div key="modal" variants={modal} initial="hidden" animate="visible" exit="exit">
      Modal
    </motion.div>
  )}
</AnimatePresence>
```

---

## Regras de uso obrigatórias

1. **Sempre use `AnimatePresence`** ao animar componentes que montam/desmontam. Sem ele, a animação de saída não executa.
2. **`key` único é obrigatório** nos filhos diretos de `AnimatePresence`.
3. **Prefira `variants` sobre props inline** (`animate={{ opacity: 1 }}`). Variants mantêm o código limpo e reutilizável.
4. **Respeite `prefers-reduced-motion`**: envolva o provider do Framer Motion ou use o hook abaixo:

```ts
// lib/motion.ts — adicione ao final
import { useReducedMotion } from "framer-motion"

export function useSafeSpring() {
  const reduced = useReducedMotion()
  return reduced ? { type: "tween", duration: 0 } : spring.smooth
}
```

5. **Não anime `width`/`height` diretamente** — use `layout` prop do Framer Motion para redimensionamentos fluidos.
6. **`layoutId`** para transições entre rotas (shared element transitions): defina um ID semântico único por elemento.

---

## O que NÃO fazer

- Não use `animate={{ transition: { ... } }}` — a `transition` vai dentro da variante ou como prop separada.
- Não crie springs com `stiffness > 600` (causa tremor) ou `damping < 15` (oscila demais).
- Não anime mais de 6 propriedades simultâneas no mesmo elemento.
- Não use `initial={false}` em `AnimatePresence` a menos que a animação de entrada inicial seja indesejada por design.

---

# LinguaFlow — Arquitetura do Sistema

## Stack

| Camada      | Tecnologia                                      |
|-------------|--------------------------------------------------|
| Backend     | Node.js + Express + Socket.IO                    |
| WhatsApp    | Baileys (via adapter `WhatsAppAdapter`)          |
| Tradução    | DeepL (primário) + OpenAI GPT-4o-mini (fallback)|
| Frontend    | React 18 + Vite + TypeScript + Zustand           |
| Animações   | Framer Motion (tokens de `client/src/lib/motion.ts`) |
| Banco       | In-memory Map (interfaces prontas para Supabase) |
| Real-time   | Socket.IO (bidirecional)                         |

## Mapa de Arquivos

```
src/
  types/index.ts                 # Interfaces TypeScript centrais
  mock/data.ts                   # Dados seed (contatos, mensagens, listas)
  server/
    index.ts                     # Express + Socket.IO (entry point)
    MessagePipeline.ts           # Orquestração inbound/outbound
    adapters/
      WhatsAppAdapter.ts         # Interface (contrato)
      BaileysAdapter.ts          # Implementação Baileys
    services/
      translation.ts             # DeepL + OpenAI
      db.ts                      # Store in-memory
client/
  src/
    App.tsx                      # UI React completa
    mockData.ts                  # Mock data frontend
    lib/motion.ts                # Tokens spring (snappy/smooth/gentle)
```

## Fluxo Inbound (cliente → operador)
1. Baileys recebe mensagem WA → `RawInboundMessage`
2. `MessagePipeline.handleInbound()` detecta idioma (DeepL)
3. Traduz para PT-BR
4. Se falhar → salva original, marca `translationStatus: 'failed'`, retry 3×
5. Salva no DB, emite `message:new` via Socket.IO

## Fluxo Outbound (operador → cliente)
1. Frontend envia `message:send` com texto em PT
2. `MessagePipeline.handleOutbound()` traduz PT → idioma do cliente
3. **Se tradução falhar → ABORTA. Nunca envia texto quebrado ao cliente**
4. Envia via WhatsApp adapter, salva no DB, emite `message:new`

## Regras Críticas

1. **Falha outbound = BLOQUEAR envio.** Nunca entregar texto garbled ao cliente.
2. **Falha inbound = salvar original**, marcar `failed`, retry até 3× com delay 5s.
3. **Idempotência por `waMessageId`** — ignorar mensagens duplicadas inbound.
4. **Timestamps sempre numéricos (epoch ms)** — nunca strings.
5. **`WhatsAppAdapter` é interface** — trocar Baileys → Cloud API sem alterar pipeline.
6. **Animações usam tokens spring** de `client/src/lib/motion.ts` — sem valores inline.

## Setup Dev

```bash
cp .env.example .env
# preencha DEEPL_API_KEY e OPENAI_API_KEY

npm run install:all
npm run dev
# Servidor: http://localhost:4000
# Cliente:  http://localhost:5173
```

## Eventos Socket.IO

| Evento             | Direção           | Payload                              |
|--------------------|-------------------|--------------------------------------|
| `wa:qr`            | server → client   | `string` (data URL)                  |
| `wa:status`        | server → client   | `'connecting' \| 'open' \| 'close'`  |
| `message:new`      | server → client   | `Message`                            |
| `message:send`     | client → server   | `{ contactId, text }`                |
| `contact:moveList` | client → server   | `{ contactId, listId }`              |
| `contact:setLang`  | client → server   | `{ contactId, lang }`                |
| `list:create`      | client → server   | `{ name, color }`                    |
| `list:rename`      | client → server   | `{ listId, name }`                   |
| `list:delete`      | client → server   | `{ listId }`                         |
| `chat:read`        | client → server   | `{ contactId }`                      |
| `bootstrap`        | server → client   | `{ contacts, messages, lists }`      |
