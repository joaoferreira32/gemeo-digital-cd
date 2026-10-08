# Retomada da Fase 6 (demo, gravação e entrega final)

Parado em 2026-10-08, a pedido (máquina desligada). Branch `fase-6`, enviado ao
GitHub como backup, **ainda sem PR**. Empilhado sobre `gargalo-memoria` (PR #9);
os PRs #7, #8 e #9 continuam abertos.

## Onde parou

- **Pronto e commitado:** p95 de espera (motor, painel K, laboratório, bench,
  cartão); agenda de manutenção ligável por entrada; demo determinística (tecla
  V) com diretor de câmera e cartão "Resultado nesta execução"; gravação MP4
  (H.264) com o formato na tela, aviso de WebM e contagem de quadros lida do
  próprio MP4 (`src/demo/mp4.ts`); GIF do README e os dois scripts; README final
  (diagrama, decisões, limitações, próximos passos, tabela da Fase 6);
  `docs/resultados.md` da Fase 6; correção do `npm run mutate` (a cópia
  temporária agora é um repositório git).
- **Mutação completa (2026-10-08):** 138 de 138 em 14 especificações, mais 1
  equivalente. Antes da correção, a `demanda.json` não rodava (linha de base
  falhava sem git na cópia) e o comando saía com código 1.
- **Teste de vazamento: pendente.** Uma medida foi feita (`demo_leak.py` no
  scratchpad: 3 demos seguidas e 1 gravada, GC forçado antes de cada leitura):
  geometrias 104, texturas 61 e programas 28 **constantes**; heap da página
  16,3 → 19,1 → 33,4 → 33,4 → 33,6 MB. O salto entre a 1ª e a 2ª demo e a
  estabilidade depois não bastam para concluir: repetir com mais rodadas (por
  exemplo 6) e ver se o heap estabiliza; o worker não foi medido.

## O que falta para abrir o PR da Fase 6

1. Conferir o estado ao retomar: `git status`, `git diff`, `git stash list`,
   `git worktree list`, nenhum processo antigo (porta 4173).
2. Terminar o teste de vazamento (acima) e pôr o resultado no README (tabela da
   Fase 6), em `docs/resultados.md` e no PR.
3. `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.
4. Push do `fase-6` (a trava de pre-push confere autor e committer noreply).
5. Abrir o PR com base `gargalo-memoria` (rascunho pronto no scratchpad da sessão,
   `pr-fase6.md`, com a conferência item a item contra o roteiro); esperar o CI.

## Pedidos para o relatório final

- **Ordem dos merges:** #7 → #8 → #9 → Fase 6; ajustar a base para a `main`
  quando necessário ("Update branch" se a proteção pedir); não apagar branches
  até os três estarem na `main`.
- **Cartão "nesta execução":** confirmar que diz "Resultado nesta execução",
  "Com IA × sem IA (roteamento estático, sem manutenção preditiva)" e aponta a
  tabela com IC do README como resultado oficial.
- **Formato do vídeo:** MP4 (H.264) 1920×1080 no Chromium, formato mostrado na
  tela; aviso quando só houver WebM. Medido: 55,5 e 58,9 FPS no arquivo, parada de
  ~0,5 s no primeiro segundo.
- **Conferência do "94 de 94":** esse número não aparece no repositório. Os
  registrados são 95 de 95 (Fase 5, README) e 138 de 138 mais 1 equivalente
  (rodada completa de 2026-10-08). Descobrir de onde veio o 94 antes de citar.
- Também relatar: a ordem das etapas da demo difere do roteiro num ponto (o
  reroteamento vem logo depois da quebra, antes da fila e do gargalo).

---

## Retomada da Fase 4 (IA de operações)

> **Concluída em 2026-10-06.** Todos os passos abaixo foram feitos: rodada 2
> refeita com checkpoints, avaliação na validação, teste causal da suavização,
> candidata e política oficial registradas antes do teste, passada única nas seeds
> de teste, documentação e PR. Este arquivo fica como registro da interrupção.

Parado em 2026-10-05, às 17h45, a pedido (máquina desligada). Retomado em
2026-10-06: checkpoints no `train.py` feitos (passo 2) e a rodada 2 rodando de
novo (passo 3). Branch `fase-4`, enviado ao GitHub como backup (ainda sem PR).

### Onde parou

- **Pronto e commitado:** desgaste antes das quebras, sinais simulados dos
  motores e detector CUSUM (calibrado, k = 3 e h = 48); heurística de roteamento
  calibrada; avaliação pareada com seeds separadas em treino, validação e teste;
  ambiente de treino em Python sobre o motor TypeScript; agente em
  onnxruntime-web (Node e navegador); tecla P com comparação ao vivo contra uma
  cópia estática; tecla 0 (desgaste); halos dos motores e setas de fluxo;
  professor (heurística em 5 níveis) e imitação; benchmarks de roteamento,
  manutenção, oscilação e as curvas de aprendizado; conferência por mutação
  (39 de 39).
- **Rodada 1** (PPO a partir de pesos aleatórios, 2M decisões): concluída e
  avaliada nas seeds de validação. Falhou em todos os itens do critério (p95
  67,6% pior que a heurística, 0 de 40 pares). Modelo em `ai/models/rodada1.*`.
- **Rodada 2** (imitação + PPO): a imitação terminou e a rede só imitada foi
  avaliada nas seeds de validação. "Quase passou": p95 +1,6% sobre a heurística
  (IC +0,8% a +2,3%), 27 de 40 pares; cumpre 7 dos 9 itens do critério (faltam
  os limiares de 28 de 40 pares e de 3% de ganho médio). Modelo em
  `ai/models/rodada2-imitacao.*`. **O PPO da rodada 2 foi interrompido** em
  860.160 de 2M decisões (32 min de treino perdidos: o `train.py` não salvava
  checkpoints, e o processo não aceita pedido de salvar de fora).
- **Oscilação** (hipótese do porquê a imitada supera a heurística): medida. A
  imitada muda a divisão cerca de 20% menos no pico e nas falhas automáticas,
  mas isso não acompanha o ganho seed a seed (Pearson −0,41 no pico, +0,13 nas
  falhas). Fica registrado como **não explicado**.
- **Documentação:** `README.md` e `docs/resultados.md` têm a Fase 4 escrita,
  menos a seção do agente, marcada com `<!-- AGENTE -->` nos dois arquivos.
- **Fora do git, só nesta máquina:** demonstrações da rodada 2
  (`ai/runs/rodada2/demos`, 88 MB), logs dos treinos (`ai/runs/`), e
  `public/models/roteamento.*`, que hoje é uma rede **aleatória** de teste e
  **não pode** ser commitada (será trocada pela rede escolhida).
- **Regras em vigor:** o critério do RL não muda; as seeds de teste são usadas
  uma única vez, numa passada só com as 4 políticas; a candidata é escolhida e
  registrada por escrito, só com base na validação, antes dessa passada.

### Próximos passos, na ordem

1. Conferir o estado ao retomar: `git status`, `git diff`, `git stash list`,
   `git worktree list`, e que nenhum processo antigo ficou rodando.
2. ~~Checkpoints periódicos e `--resume` no `train.py`~~ (feito em 2026-10-06:
   a cada 250 mil decisões; testado matando um treino curto depois do primeiro
   checkpoint e retomando até o fim).
3. Rodar a rodada 2 de novo, com a mesma configuração (é a mesma rodada, não uma
   nova; cerca de 75 min). **Em andamento desde 2026-10-06, 11h10.** A rede só
   imitada saiu idêntica bit a bit à já avaliada (mesmo hash). Se for
   interrompida, o mesmo comando com `--resume` continua do último checkpoint:
   `ai/.venv/Scripts/python ai/train.py --name rodada2 --imitate 400 --lr 1e-4 --ent 0.001 --clip 0.1 --seed 2`
   (a tentativa interrompida em 2026-10-05 está em `ai/runs/rodada2-interrompida/`).
4. Avaliar nas seeds de validação: `npm run bench:rotas -- --rl rodada2-imitacao,rodada2`
   e `npm run bench:oscilacao -- --rl rodada2-imitacao,rodada2` (completa a
   medição de oscilação com a rede final).
5. Se a rede final não cumprir o critério, decidir se vale a rodada 3 (a última
   do prazo, até 2M decisões), com o ajuste justificado pela validação.
   Depois da rodada 2 (aprovado): teste causal da suavização, só como análise,
   com a heurística oficial sem mudança.
6. Escrever em `docs/resultados.md` qual é a candidata principal e por quê, só
   com a validação, e **commitar antes** de tocar nas seeds de teste.
7. Passada única nas seeds de teste:
   `npm run bench:rotas -- --set test --final --rl rodada2-imitacao,<final>`
   (estática, heurística, imitada e final) e
   `npm run bench:manutencao -- --set test --final`.
8. Copiar a rede escolhida para `public/models/roteamento.onnx` e `.json`
   (substituindo a rede aleatória); conferir no navegador (tecla P, tempo por
   decisão no painel K) e tirar as capturas.
9. Gerar as curvas (`node scripts/curvas.mjs rodada1 rodada2 ...`), preencher as
   seções `<!-- AGENTE -->`, a tabela de números da Fase 4 e a contagem de testes;
   registrar a imitada como "quase passou".
10. `npm test`, `npm run lint`, `npm run build`, `npm run bench`; conferir os
    autores dos commits (noreply); push, PR e parar para revisão, com as
    explicações do PPO (até 10 linhas) e do CUSUM (até 5 linhas).

### Pendente de decisão do usuário

- CUSUM por sinal, além do combinado, para pegar parte dos 23% de desgastes que
  aparecem num sinal só (troca por mais alarmes falsos com pancadas e enroscos).
  Recomendação dada: não fazer na Fase 4; registrar no README como próximo passo.

Decidido: teste causal da suavização aprovado (depois da rodada 2, só como
análise, heurística oficial sem mudança).
