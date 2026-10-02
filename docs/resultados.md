# Resultados medidos

Todos os números do projeto, por fase, com a forma de reproduzir cada um.
Nenhum foi estimado: vêm do motor de simulação, dos testes automatizados ou
de benchmarks que estão no repositório.

## Como foi medido

- **Máquina de desenvolvimento:** Windows 11, Node.js 24.21, Chromium
  (Playwright) com GPU dedicada (NVIDIA RTX 5060 Ti via ANGLE/Direct3D 11). Um
  notebook comum fica abaixo nos números de FPS, e por isso o app reduz a
  qualidade sozinho quando o FPS cai.
- **CI:** runners `ubuntu-latest` do GitHub Actions, Node 24.
- **Determinismo:** a mesma seed reproduz a mesma simulação. As comparações
  "com e sem" usam a mesma seed, então a demanda é idêntica nos dois lados.
- Tempos de execução (milissegundos, passos por segundo) variam um pouco entre
  rodadas; quando há mais de uma medição, os valores aparecem como faixa.

---

## Fase 1 — galpão 3D e fluxo de esteiras

### Fluxo

| O que                                                    | Resultado                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Regime normal (3,6 pedidos/s), 6 min simulados           | 212 pacotes/min, tempo médio no sistema 31,6 s, fila ≈ 5, 1.156 entregues              |
| Capacidade de uma esteira (2,0 m/s, espaçamento 0,6 m)   | 3,33 pacotes/s                                                                         |
| Esteira mais carregada (E9, B3→B4)                       | 2,70 pacotes/s, 81% da capacidade (as duas linhas convergem nela)                      |
| Esteiras sem rota alternativa                            | 3 (A4→S1, B3→B4, B4→S2), verificado por teste                                          |
| Esteira da doca 3 parada por 2 min                       | fila de 0 → 428 pacotes; 8 min após o conserto, 109                                    |
| Mesma falha com a doca servindo 1,0 / 1,2 / 1,5 pacote/s | ritmo de escoamento idêntico: o limite é a folga da esteira mais carregada, não a doca |

### Desempenho

| O que                               | Resultado                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| Teste de carga                      | 2.288 pacotes desenhados a 60 FPS, qualidade alta                                                 |
| Mesmo teste com a CPU limitada a 4× | cai para qualidade média sozinho e volta a 60 FPS                                                 |
| Custo por quadro no teste de carga  | simulação 0,002 ms/passo · pacotes 0,19 ms · render 3,1 ms (alta), 1,1 ms (média), 1,0 ms (baixa) |
| Chamadas de desenho por quadro      | 294 (alta), 203 (média), 159 (baixa)                                                              |
| Otimização de chamadas de desenho   | 433 → 284 (anéis instanciados, peças dos caminhões mescladas)                                     |
| 5 reinícios seguidos                | geometrias e texturas na GPU estáveis (89 e 45)                                                   |
| Carregamento da demo publicada      | cena pronta em 1,9 s no primeiro acesso, 0,3 s com cache                                          |
| Testes automatizados ao fim da fase | 43                                                                                                |

---

## Fase 2 — frota de robôs, falhas e mapa de calor

### Segurança da frota (40 robôs)

Testes em `tests/fleet.test.ts`: 6 seeds × 10.000 passos com falhas injetadas
(esteira A4→S1 quebrada por 2 min, dois robôs com defeito, doca bloqueada),
mais um turno de 1.000 s com carga pesada.

| O que                                           | Resultado                                         |
| ----------------------------------------------- | ------------------------------------------------- |
| Menor distância entre centros de dois robôs     | 0,974 m (mínimo seguro: 0,89 m)                   |
| Frenagens acima do limite (2,5 m/s²)            | 0                                                 |
| Maior atraso de um robô em relação ao plano     | 0,50 s (a folga das reservas é de 1 s)            |
| Maior tempo de um robô sem conseguir planejar   | 15 s (com robôs em defeito no caminho)            |
| Tarefas no turno de 1.000 s                     | 246, com recargas de bateria e sem bateria zerada |
| Rotas aleatórias de um robô sozinho (pior caso) | 0,52 s de atraso (zigue-zague curto)              |

### Planejamento (Cooperative A\*)

`npm run bench:mapf`, 3 seeds × 10 min cada.

| O que                                  | Turno normal | Cenário duro¹ |
| -------------------------------------- | ------------ | ------------- |
| Tarefas concluídas                     | 459          | 467           |
| Planos                                 | 1.390        | 1.394         |
| Tentativas sem caminho                 | 18 (1,3%)    | 38 (2,7%)     |
| Tempo por plano, média                 | 0,72–0,74 ms | 1,10 ms       |
| Tempo por plano, p95                   | 1,62–1,71 ms | 6,0 ms        |
| Tempo por plano, máximo                | 28,9 ms      | 24,9 ms       |
| Estados expandidos por plano (média)   | 1.179        | 1.439         |
| Rota planejada ÷ caminho livre (média) | 1,07         | 1,12          |
| Menor distância entre robôs            | 0,979 m      | 0,973 m       |

¹ Falhas automáticas ligadas, 0,8 pedido de estoque/s (normal: 0,45) e 5
pedidos/s nas entradas (normal: 3,6).

**O que acontece numa tentativa sem caminho:**

| O que                                                | Turno normal  | Cenário duro                    |
| ---------------------------------------------------- | ------------- | ------------------------------- |
| Episódios (falhas seguidas até conseguir um caminho) | 5             | 9                               |
| Resolvidos na primeira nova tentativa                | 2             | 0                               |
| Duração média do episódio                            | 3,6 s         | 4,2 s                           |
| Episódio mais longo                                  | 10 s          | 9 s                             |
| Onde o robô esperava                                 | 18 em estação | 35 em estação, 3 em piso aberto |
| Em corredor estreito ou passagem sob esteira         | 0             | 0                               |
| Ainda sem caminho no fim da simulação                | 0             | 0                               |
| Pedidos para outro robô sair da frente               | 0             | 5                               |

### Correção que a medição revelou

A posse de uma estação era liberada quando o robô terminava a tarefa, mas ele
só sai da célula no passo seguinte; outros robôs eram mandados para lá e
falhavam ao planejar. Mesma medição, antes e depois:

| O que                          | Antes   | Depois  |
| ------------------------------ | ------- | ------- |
| Tentativas sem caminho         | 31%     | 1,3%    |
| Tempo por plano, média         | 6,96 ms | 0,72 ms |
| Tempo por plano, p95           | 22,4 ms | 1,62 ms |
| Rota planejada ÷ caminho livre | 1,11    | 1,07    |

### Desvio por robôs

A4→S1 quebrada por 3 min; mesma seed com e sem os robôs fazendo o desvio
(`tests/failures.test.ts`).

| Seed | Pico da fila (sem → com) | Entregas até o conserto (sem → com) | Entregas 2 min depois | Pacotes levados pelos robôs |
| ---- | ------------------------ | ----------------------------------- | --------------------- | --------------------------- |
| 2026 | 738 → 602 (−18%)         | 257 → 369 (+44%)                    | 833 → 984             | 78                          |
| 7    | 676 → 540 (−20%)         | 234 → 345 (+47%)                    | 829 → 977             | 90                          |
| 11   | 699 → 550 (−21%)         | 256 → 371 (+45%)                    | 847 → 999             | 78                          |

Os robôs levam cerca de 0,45 pacote/s pelo desvio; a esteira leva 1,8: o
desvio alivia, não substitui.

### Interface com a simulação num Web Worker

Teste de carga (mais de 2.000 pacotes), 40 robôs, velocidade 16×, falhas
automáticas, 15 s de medição. `?sim=main` roda a mesma simulação na thread da
página. Tarefas longas: Long Tasks API do Chromium (bloqueios acima de 50 ms).

| Cenário                              | Worker                                                        | Thread da página                                                                |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Carga contínua                       | 0 tarefas longas, p99 do quadro 16,8 ms                       | 1 tarefa longa (65 ms), p99 33,3 ms                                             |
| Saltos de 2 min simulados a cada 3 s | 0 tarefas longas, pior quadro 16,8 ms, 60 FPS, qualidade alta | 8 tarefas longas (4,8 s), pior quadro 250 ms, 47 FPS, qualidade caiu para média |

### Mapa de calor

CPU gasta por quadro, média de 600 quadros (`__gemeo.benchHeat()` no console).

| Situação                           | Na GPU (posições + 2 passes) | Referência na CPU (splats + envio da textura) |
| ---------------------------------- | ---------------------------- | --------------------------------------------- |
| Normal (≈90 pacotes nas esteiras)  | 0,04–0,08 ms                 | 0,46–0,49 ms                                  |
| Teste de carga (≈187 nas esteiras) | 0,03–0,07 ms                 | 0,64–0,67 ms                                  |

Textura de 272 × 160 texels (4 por metro).

### Desempenho e memória

| O que                               | Resultado                                                               |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Teste de carga com a frota          | 2.369 pacotes desenhados + 40 robôs a 60 FPS, qualidade alta, com bloom |
| 5 reinícios seguidos                | geometrias 104 → 103, texturas 61 → 59 (sem crescer)                    |
| Build de produção                   | JS principal 680 kB (179,8 kB gzip); worker da simulação 52,5 kB        |
| Testes automatizados ao fim da fase | 103                                                                     |

### Benchmark do motor

`npm run bench` (Node, aquecimento descartado, mediana de 5).

| Caso                      | Máquina local                      | CI, 5 execuções (média e variação)      |
| ------------------------- | ---------------------------------- | --------------------------------------- |
| Motor sem robôs           | 941 mil passos/s                   | 676 mil passos/s, ±8,9% (amplitude 23%) |
| Motor com 40 robôs        | 4.086 passos/s (≈68× o tempo real) | 3.677 passos/s, ±11,4% (amplitude 30%)  |
| Teste de carga + 40 robôs | 3.956 passos/s                     | 3.584 passos/s, ±11,8% (amplitude 32%)  |
| Snapshot com 40 robôs     | 0,27 ms                            | 0,31 ms, ±10,4% (amplitude 29%)         |

**Ruído da comparação no mesmo runner (teste A/A, mesmo código duas vezes,
5 execuções):** pior diferença de 1,8%, 3,4% e 2,3% nos três casos de passos
por segundo, e 8,5% no snapshot. Por isso o CI bloqueia regressões acima de 10%
nos passos por segundo (com uma segunda rodada de confirmação antes de
falhar) e só avisa no snapshot.

---

## Bugs que só apareceram medindo

| Fase | Sintoma medido                                                     | Causa                                                            | Efeito da correção                                          |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| 1    | Fila de entrada crescendo em regime normal (297 pacotes em 15 min) | esteira E9 recebendo 2,7 pacotes/s com capacidade de 2,46        | esteiras a 2,0 m/s: E9 a 81%, fila estável                  |
| 1    | +1 textura na GPU a cada reinício                                  | só a textura do ambiente era liberada, não o render target       | memória estável em 5 reinícios                              |
| 1    | 433 chamadas de desenho por quadro                                 | um objeto por anel e por peça de caminhão                        | 284                                                         |
| 1    | CPU 4× mais lenta ficava em 49–51 FPS sem reduzir qualidade        | alvo do ajuste automático em 50 FPS                              | alvo 55: cai para média e volta a 60 FPS                    |
| 2    | Frenagens acima do limite ao alcançar a referência                 | curva de frenagem contínua avaliada tick a tick                  | curva discreta e checagem da referência futura: 0 violações |
| 2    | Frenagem brusca logo após replanejar                               | o novo plano mudava a curva na célula seguinte                   | compromisso 2 passos à frente: 0 violações em 8 seeds       |
| 2    | Exceção "célula já reservada"                                      | robô precisando parar numa célula que outro reservaria no futuro | esse outro também replaneja                                 |
| 2    | 31% das tentativas de planejamento sem caminho                     | estação liberada com o robô ainda em cima                        | 1,3%, e plano 10× mais rápido                               |

## Como reproduzir

```bash
npm test             # segurança da frota, desvio, falhas, determinismo
npm run bench        # benchmark do motor
npm run bench:mapf   # planejamento e episódios sem caminho
npm run dev          # depois, no console do navegador: __gemeo.benchHeat()
```

As medições de interface (tarefas longas, FPS, memória) usaram o Chromium
via Playwright; `?sim=main` liga a simulação na thread da página para a
comparação.
