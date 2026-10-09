# Retomada da Fase 6 (demo, gravação e entrega final)

> **Concluída em 2026-10-09.** Todos os passos abaixo foram feitos: a investigação
> dos 22 MB (não era vazamento: era a medida, ver "Memória ao repetir a demo" em
> `docs/resultados.md`), o README, o `docs/resultados.md` e o GIF na ordem nova, a
> conferência por mutação completa (142 de 142, mais 1 equivalente) e o PR da
> Fase 6, empilhado sobre o #9. Este arquivo fica como registro das interrupções.

Parado em 2026-10-09, a pedido (máquina desligada), pela segunda vez. Branch
`fase-6`, enviado ao GitHub como backup, **ainda sem PR**. Empilhado sobre
`gargalo-memoria` (PR #9); os PRs #7, #8 e #9 continuam abertos.

## Onde parou

- **Pronto, testado e commitado:**
  - a parada anterior (2026-10-08): p95 de espera, agenda ligável, demo, diretor
    de câmera, gravação MP4 com contagem de quadros, README final, correção do
    `npm run mutate`;
  - **a ordem da demo segue o roteiro** (decisão de 2026-10-09, commit
    `ce7192f`): roteamento estático e sem agenda até 146 s; a IA (heurística e
    agenda juntas) só assume depois da fila (110–128 s) e do gargalo explicado
    (128–146 s). Até 146 s as execuções com e sem IA são idênticas bit a bit
    (teste). A volta no tempo abre o ramo com `rec.branch()`; as entradas da IA
    são marcadas e o lado sem IA não as recebe. A seed 2026 continua cumprindo os
    três critérios (quebra até 189,8 s, alarme 215 s, evitada 216 s; sem IA, a
    Esteira 16 quebra aos 222,8 s). Cartão novo: entregas 730 × 485 (+51%), p95 do
    ciclo 135 × 180 s (−25%), p95 de espera 89 × 133 s (−33%), pior fila 403 × 548
    (−26%), quebras 1 × 2, evitadas 1 × 0. 302 testes, lint e tipos ok;
    mutações da demo 18 de 18 (6 novas). Total esperado da rodada completa:
    142 de 142, mais 1 equivalente (não rodada inteira depois da mudança);
  - entrada de 2026-10-09 em `docs/roteiro.md`.
- **No disco, NÃO commitado (de propósito, incompleto):** `README.md` (lista das
  etapas e texto alternativo do GIF na ordem nova) e `docs/resultados.md` (seção
  "A demo: roteiro e escolha da seed" com a ordem nova e o resultado novo). O que
  está escrito ali foi conferido; falta o resto da lista abaixo. Conferir com
  `git diff` ao retomar.
- **Medidas feitas nesta sessão (ainda fora dos documentos):**
  - demo no navegador (Chromium, build de produção): 49,7 s até o cartão nas 6
    rodadas (49,7–49,8 s), mais 8 s de cartão; sem erros de console;
  - gravação da demo nova: MP4 (H.264) 1920×1080, 101,8 MB, 3.123 quadros em
    57,9 s (54,0 FPS), maior intervalo 482 ms aos 0,2 s, 3.447 quadros desenhados;
    o leitor em Python (`mp4frames.py`) conta o mesmo;
  - vazamento, worker (o `SimHost` no Node, `--expose-gc`, 15 ciclos de demo
    completa + volta ao app): heap 12,6 MB antes; 11,3 MB depois da 1ª demo e
    12,1 MB depois da 15ª (cerca de 0,05 MB por ciclo nos últimos 10). Uma gravação
    da demo retida seria mais de 1 MB por ciclo (estimativa pelos 15,5 MB por hora
    simulada da Fase 3);
  - vazamento, página (6 demos + 1 gravada): geometrias 104, texturas 61 e
    programas 28 **constantes**; heap 11,4 → 20,2 → 33,5 → 33,5 → 33,6 → 33,7 →
    33,8 MB (34,4 depois da gravada). **Com o app rodando sem demo**, o heap vai e
    volta (11,4 → 22,3 → 11,5 → 11,7 → 11,7 MB em 200 s): os cerca de 22 MB que
    ficam depois da 2ª demo **não** são explicados pelo app parado. Crescem só
    0,1 MB por demo depois disso. **Pendente:** achar o que segura esses 22 MB
    (comparar um heap snapshot do app parado com um depois de 2 demos) antes de
    escrever a conclusão do teste de vazamento.

## O que falta para abrir o PR da Fase 6

1. Ao retomar: `git status`, `git diff` (as duas edições acima), `git stash list`,
   `git worktree list`, nenhum processo antigo (porta 4173).
2. Vazamento da página: identificar os ~22 MB (acima) e, se for retenção da
   demo, corrigir e medir de novo; depois escrever o resultado (worker e página)
   no README, em `docs/resultados.md` e no PR.
3. Terminar a documentação: tabela da Fase 6 do README (cartão novo; 49,7 s +
   8 s; gravação nova; mutação 142 de 142 em 14 especificações, mais 1
   equivalente, 34 novas: espera 9, demo 18, vídeo 7; vazamento), a limitação de
   FPS do README, e as seções do navegador e da gravação em `docs/resultados.md`
   (os números de 2026-10-08 ficam como os da primeira versão da demo).
4. Refazer o GIF (o atual mostra a ordem antiga e o cartão antigo): `npm run
build`, `npx vite preview`, `python scripts/demo_frames.py
http://localhost:4173/ quadros` (Playwright) e `ai/.venv/Scripts/python
scripts/demo_gif.py quadros docs/demo.gif`.
5. `npm run mutate` completo (esperado 142 de 142, mais 1 equivalente), `npm run
lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.
6. Commit, push do `fase-6` (a trava confere autor e committer noreply) e PR com
   base `gargalo-memoria`: descrição com a conferência item a item contra o
   roteiro e a ordem exata dos merges; esperar o CI.

## Pedidos para o relatório final

- **Ordem exata dos merges:** #7 → #8 → #9 → Fase 6; ajustar a base para a `main`
  quando necessário ("Update branch" se a proteção pedir); não apagar branches
  até os três estarem na `main`.
- **Cartão "nesta execução":** "Resultado nesta execução", "Com IA × sem IA
  (roteamento estático, sem manutenção preditiva)" e a nota apontando a tabela com
  IC do README como resultado oficial.
- **Formato do vídeo:** MP4 (H.264) 1920×1080 no Chromium, formato mostrado na
  tela; aviso quando só houver WebM.
- **Ordem da demo:** agora segue o roteiro (problema, diagnóstico, solução),
  conferida por teste.
- **"94 de 94":** decidido em 2026-10-09: vale o registrado (95 de 95 na Fase 5),
  nada a corrigir.

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
