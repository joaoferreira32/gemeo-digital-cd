# gemeo-digital-cd

Gêmeo digital de um centro de distribuição: simulação 3D em tempo real no
navegador (Vite + TypeScript + Three.js, sem framework de UI), motor
determinístico em `src/sim/` rodando num Web Worker, Vitest, ESLint + Prettier,
CI no GitHub Actions e deploy estático no GitHub Pages. Projeto de portfólio,
construído em 6 fases; detalhes no README e todos os números medidos em
`docs/resultados.md`.

## Ao retomar uma sessão (antes de qualquer commit)

Uma sessão pode cair no meio de qualquer comando (já caiu no meio de um teste de
mutação e deixou uma linha alterada de propósito no código). Ao retomar:

1. `git status` e `git diff`: conferir **cada** mudança e entender de onde veio.
   O que não for intencional é desfeito antes de seguir.
2. `git stash list` e `git worktree list`: nada esquecido de uma sessão anterior.
3. Rodar `npm run lint` e `npm test` antes do primeiro commit.

## Testes de mutação

Sempre com `npm run mutate` (todas as especificações) ou
`npm run mutate -- mutations/<arquivo>.json`. O script copia a árvore
de trabalho para uma pasta temporária, aplica as mutações **só na cópia**, apaga a
cópia no fim e confere que `git status` e `git diff` do repositório não mudaram.
Nunca alterar arquivos do repositório para testar uma mutação. As especificações
ficam em `mutations/`; quem afirma "conferido por mutação" aponta para elas.

## Regras de trabalho

- Fases: antes de cada uma, mostrar o plano em até 15 linhas e esperar a
  aprovação; ao fim, rodar testes, rodar o app, resumir e parar para revisão.
- Cada fase entrega (a) um efeito visual marcante, (b) engenharia testável e
  (c) um número medido que prove o ganho.
- **Teste antes de afirmar:** todo número citado no README, nos commits ou nos
  PRs vem do motor ou de algo reproduzível no repositório (benchmarks e
  testes). Número de script descartável não vale.
- Código e comentários em inglês; interface, README e documentos em português.
- Sem dados pessoais, chaves ou assets com direitos autorais: todo modelo 3D e
  toda textura são gerados por código.
- Commits pequenos, Conventional Commits, com o e-mail noreply do GitHub como
  autor e committer; conferir autor e committer de todos os commits antes de
  qualquer push.
- A `main` é protegida: só recebe merge por PR, com `check` (lint, testes, build)
  e `bench` passando e o branch atualizado.
- 60 FPS com 2.000 pacotes e 40 robôs, com degradação automática de qualidade; sem
  vazamento de memória ao reiniciar ou viajar no tempo.
- Dentro de `src/sim/` não pode `Math.random`, `Date.now`, `performance.now` nem
  Three.js (o ESLint barra): o motor é determinístico.

## Comandos

```bash
npm run dev          # http://localhost:5173 (?sim=main roda a simulação na página)
npm test             # Vitest
npm run lint         # ESLint + Prettier
npm run build
npm run bench        # benchmark do CI (compara com a base)
npm run bench:mapf   # planejamento multiagente
npm run bench:vigia  # impasses e defeitos em corredor estreito
npm run bench:tempo  # uma hora simulada: memória e seek (~3 min)
npm run mutate       # todas as especificações de mutations/, numa cópia temporária
```
