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

`npm run bench:motor` (Node, aquecimento descartado, mediana de 5).

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

## Fase 3 — viagem no tempo e observabilidade

### Vigia anti-travamento

Cenários montados de propósito no mapa real (`src/sim/scenarios.ts`), nos 4
portões que são a única entrada das faixas de doca (1 célula entre duas paredes
de esteira, o corredor mais estreito que os robôs usam). Depois de 6 s sem
caminho, o vigia monta o grafo de quem espera quem; num ciclo, testa um recuo
para cada robô e manda recuar o que sai da frente mais rápido; atrás de um robô
com defeito, troca a entrega para a outra baia da mesma doca, se ela puder ser
alcançada.

**Dois robôs parados esperando um pelo outro, pedidos de passagem falhando**
(desligados de propósito). 4 portões × 3 posições (em volta do portão ou um
deles dentro) × 3 cargas (os dois vazios, um ou outro carregado) = 36 casos:

| O que                                 | Sem vigia                          | Com vigia |
| ------------------------------------- | ---------------------------------- | --------- |
| Casos travados                        | 36 de 36 (nenhum se move em 2 min) | 0 de 36   |
| Tempo até os dois passarem, pior caso | —                                  | 18,6 s    |
| Tempo até os dois passarem, mediana   | —                                  | 18,6 s    |
| Menor distância entre robôs           | —                                  | 1,000 m   |
| Frenagens acima do limite             | —                                  | 0         |

Os 18,6 s são 6 s até o vigia agir, o recuo (3 a 4 passos), a espera de 4 s de
quem recuou e a volta dele. O teste exige no máximo 20 s em todos os casos. O
mesmo vale para uma troca de lugares (cada robô quer a célula onde o outro
está): sem vigia, os dois seguem parados depois de 89 s; com vigia, espera
máxima de 6 s (o teste exige até 7 s).

**Robô com defeito dentro do portão por 60 s.** Um robô fica preso na faixa
atrás dele; dois precisam entregar em docas cuja baia mais próxima fica atrás do
portão (cada uma tem uma segunda baia, alcançada por outro caminho). Igual nos 4
portões:

| Espera máxima                      | Sem vigia | Com vigia                  |
| ---------------------------------- | --------- | -------------------------- |
| Robô preso atrás do defeito        | 60 s      | 60 s (o tempo do conserto) |
| Robôs com outra baia para entregar | 60 s      | 7 s                        |

Para o robô preso não há o que fazer: o único caminho passa pelo robô quebrado,
e a espera fica limitada pelo conserto (40 a 60 s no injetor de falhas). Num
portão que tem outro ao lado (as passagens sob as linhas principais), ninguém
espera: o planejador já contorna pelo outro.

**Custo de uma tentativa sem caminho** (robô preso atrás de um robô parado):

| O que                                 | Só a busca no espaço-tempo | Com a prova no piso |
| ------------------------------------- | -------------------------- | ------------------- |
| Uma tentativa (duas rodadas)          | 19,0–19,9 ms               | 0,0019–0,002 ms     |
| CPU dos 36 casos de impasse com vigia | 11,8 s                     | 1,8 s               |

A prova trata como parede as células que outro robô já segura (elas não abrem
durante a busca) e faz uma busca em largura no piso. Ela ignora o tempo e as
regras de movimento, então nunca recusa um caminho que a busca acharia: um
teste compara as duas respostas em 400 casos aleatórios (191 com caminho, 209
sem), com 0 diferenças. No turno normal e no cenário duro (`npm run bench:mapf`)
os resultados ficaram idênticos aos da Fase 2 e o benchmark do motor ficou
dentro do ruído (−1,2% a +2,6%).

### Viagem no tempo

Uma hora simulada com 40 robôs e falhas automáticas (`npm run bench:tempo`,
seed 2026, Node 24, mesma máquina das outras medições):

| O que                                        | Resultado                                                 |
| -------------------------------------------- | --------------------------------------------------------- |
| Checkpoints (a cada 30 s simulados)          | 121; média 122 KB, máximo 172 KB                          |
| Tempo para gravar um checkpoint              | mediana 1,2 ms, máximo 23 ms                              |
| Memória da gravação                          | 15,5 MB por hora (14,5 MB de checkpoints)                 |
| Voltar a um instante sorteado (60 sorteios)  | mediana 253 ms, p95 484 ms, máximo 580 ms                 |
| Mesmo instante refazendo tudo desde o tick 0 | 34 s na meia hora, 65 s no fim da hora (≈255× mais lento) |

Numa execução curta e caótica (120 s, falhas automáticas, 0,6 pedido de estoque/s
e 4,5 pedidos/s nas entradas), um checkpoint tem 82 KB (`tests/checkpoint.test.ts`);
numa hora com falhas, as filas crescem e com elas o checkpoint.

Antes da codificação compacta das filas de entrada, os checkpoints tinham 211 KB
em média (326 KB no máximo) e a gravação ocupava 26 MB por hora: 3.595 dos 4.833
pacotes do maior checkpoint esperavam nas entradas, ainda com os valores de
criação, e passaram de 60 para 16 bytes cada.

**Reconstrução idêntica** (`tests/checkpoint.test.ts`, `tests/recorder.test.ts`):
restaurado em 48 instantes de duas execuções caóticas (a cada 10 s, com
caminhões carregando, robôs com defeito e falhas automáticas) e em 48 instantes
de esperas resolvidas pelo pedido de passagem e pelo vigia, o mundo continua
igual ao original: impressão digital, bytes do snapshot e estatísticas da
frota. Voltar a 30 instantes sorteados de uma gravação com falhas manuais e
automáticas e teste de carga mostra exatamente o estado que o mundo tinha ao vivo.
Continuar a partir do passado com uma entrada nova dá o mesmo que uma execução
nova com as mesmas entradas. Onze campos esquecidos de propósito na codificação
(posição anterior do pacote, soma da janela de métricas, sorteio de pedidos,
início de um hold, espera de um robô, pausa depois de sair da frente, início da
falha de planejamento, velocidade, próximo sorteio de falha, carga do caminhão,
rodízio das junções) foram todos pegos pelos testes.

**Sem vazamento em 50 viagens no tempo:**

| Onde                                  | Antes                       | Depois                      |
| ------------------------------------- | --------------------------- | --------------------------- |
| GPU (Chromium, 50 viagens, 5 ramos)   | 101 geometrias, 62 texturas | 101 geometrias, 62 texturas |
| Heap da página (após coleta forçada)  | 12,98 MB                    | 13,23 MB                    |
| Heap da simulação, 60 viagens         | —                           | +0,77 MB (caches aquecendo) |
| Heap da simulação, mais 60 viagens    | —                           | +0,03 MB                    |
| Bytes da gravação (teste, 50 viagens) | iguais                      | iguais; só 2 mundos em uso  |

**Custo de gravar no motor ao vivo** (`npm run bench:motor`, mediana de 5): 4.231
passos/s rodando pela gravação contra 4.210 passos/s do motor sozinho, dentro do
ruído entre repetições (1,1% a 1,8%).

### Indicadores do painel de operação

Calculados no worker para o instante mostrado (ao vivo ou passado), a partir de
uma amostra por segundo com contadores acumulados: uma janela é uma subtração.

- **Vazão:** entregas no último minuto (no começo da execução, as entregas até
  ali; nunca extrapola um trecho curto).
- **Tempo de ciclo médio e p95:** sobre todas as entregas dos últimos 5 min,
  do pedido à doca. O p95 é exato (seleção, posto mais próximo); um teste o
  compara com a ordenação completa em 300 conjuntos aleatórios com empates.
- **Utilização:** esteira = pacotes que saíram ÷ capacidade (velocidade ÷
  espaçamento); doca = entregas ÷ taxa de serviço; robô = fração do tempo
  buscando, carregando, entregando ou descarregando.
- **Alerta de robô travado:** 20 s sem caminho geram um evento e o alerta
  vermelho na cena; quando ele volta a planejar, outro evento diz quanto esperou.
  No robô preso atrás de um robô quebrado no portão, o alerta sai entre 20 e 22 s
  depois da primeira falha de planejamento e o retorno diz "voltou a andar após
  60 s" (`tests/watchdog.test.ts`).

**Cores dos gráficos.** Os estados dos robôs usam os tons da cena (ciano
trabalhando, âmbar recarregando, vermelho com defeito, cinza ocioso), escurecidos
para a faixa de luminosidade de gráficos sobre o painel escuro (`#10161d`) e
conferidos com o validador de paleta (simulação de daltonismo): na ordem defeito,
trabalhando, recarregando, ociosos, o par vizinho mais parecido fica a ΔE 10,3
para daltonismo (mínimo recomendado 8) e 19,6 para visão normal (mínimo 15). As
cores da marca, sem escurecer, saíam da faixa de luminosidade; na ordem com âmbar
ao lado do vermelho, o par caía para ΔE 13,7 (visão normal), abaixo do mínimo. O
cinza dos ociosos tem croma baixo de propósito (é o tom de fundo). Os três
indicadores dos últimos 5 minutos têm escalas diferentes e ficam em três gráficos
pequenos, cada um com o próprio eixo.

### Conferência por mutação

`npm run mutate` (todas as especificações de `mutations/`)
aplica cada mutação numa cópia temporária do código (nunca nos arquivos do
repositório) e roda os testes daquela parte:

| Especificação | O que muda de propósito                                                                                         | Pegas pelos testes |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| vigia         | ciclos e desvios do vigia, escolha de quem recua, pedido de passagem, alerta de travado, prova de "sem caminho" | 9 de 9             |
| checkpoint    | um campo esquecido na codificação                                                                               | 11 de 11           |
| gravador      | entradas no tick do checkpoint, cortes da ramificação, p95, teste de carga no reinício                          | 10 de 10           |

A execução completa leva cerca de 5 min. Interrompida à força no meio de uma
mutação, a árvore de trabalho ficou idêntica (`git status` e `git diff`); só a
cópia temporária sobrou, e a primeira execução depois de uma hora a apaga.

### No CI e no navegador

**Benchmark do motor no PR da Fase 3** (mesmo runner, base = `main` da Fase 2):

| Caso                                 | Base    | Fase 3  | Diferença            |
| ------------------------------------ | ------- | ------- | -------------------- |
| Motor sem robôs (passos/s)           | 645.579 | 642.207 | −0,5%                |
| Motor com 40 robôs (passos/s)        | 3.347   | 3.403   | +1,7%                |
| Motor gravando, 40 robôs (passos/s)  | —       | 3.396   | caso novo            |
| Teste de carga + 40 robôs (passos/s) | 3.266   | 3.309   | +1,3%                |
| Snapshot com 40 robôs (ms)           | 0,343   | 0,352   | −2,7% (só relatório) |

**Chromium:** ao vivo → passado (efeito aplicado por completo, "Revendo o
passado") → histórico por clique → continuar daqui, também com a simulação na
thread da página (`?sim=main`), sem erros no console. O único aviso de shader
(compilador do Direct3D) já aparecia na Fase 2.

**Testes:** 141 em 18 arquivos ao fim da fase (103 ao fim da Fase 2).

---

## Fase 4 — IA de operações

### Como as políticas de roteamento foram comparadas

Quatro cenários de 10 minutos simulados, o primeiro minuto descartado (o
galpão enchendo): **normal**; **esteira com alternativa quebrada** (Esteira 3,
A2→A3, aos 120 s e Esteira 8, B2→B3, aos 330 s, 60 a 90 s cada); **pico de
pedidos** (demanda 22% acima do normal e dois picos de 2,5× por 45 s); **falhas
automáticas**. Só contam os pacotes que entram pelas esteiras: os pedidos de
estoque vão do rack à doca por robô, sem passar por nenhuma escolha, e o ciclo
deles (p95 de 128 s contra 37 s nas esteiras) esconderia o efeito. Cada
política roda as mesmas seeds com os mesmos pedidos; os ganhos são pareados
seed a seed, com intervalo de confiança de 95% (t de Student, 9 graus de
liberdade). "Idade máxima" é a idade do pacote mais velho ainda no galpão, no
pior momento do episódio.

Seeds: treino 10.001 a 19.999 (episódios do PPO e demonstrações da imitação),
validação 20.001 a 20.010 (calibração da heurística e do detector, julgamento
das rodadas da IA), teste 30.001 a 30.010 (uma única vez, no resultado final;
os benchmarks recusam sem `--final`).

### Heurística contra o roteamento estático (seeds de validação)

`npm run bench:rotas`, parâmetros da heurística: peso da fila 0,5, escala 0,5 s,
suavização 0,3.

| Cenário                          | p95 do ciclo (estática → heurística) | ganho no p95 (IC 95%)    | seeds melhores | ganho no p99 | idade máxima (estática → heurística) | vazão  |
| -------------------------------- | ------------------------------------ | ------------------------ | -------------- | ------------ | ------------------------------------ | ------ |
| Normal                           | 37,4 s → 36,7 s                      | +1,7% (+1,2% a +2,1%)    | 10 de 10       | +3,3%        | 42,7 s → 41,0 s                      | +0,0%  |
| Esteira com alternativa quebrada | 107,6 s → 46,5 s                     | +56,6% (+53,7% a +59,5%) | 10 de 10       | +11,0%       | 120,1 s → 115,8 s                    | +4,1%  |
| Pico de pedidos                  | 184,3 s → 121,6 s                    | +34,0% (+31,0% a +36,9%) | 10 de 10       | +28,9%       | 211,0 s → 151,8 s                    | +11,5% |
| Falhas automáticas               | 210,1 s → 163,6 s                    | +21,5% (+13,7% a +29,2%) | 10 de 10       | +17,2%       | 340,8 s → 337,0 s                    | +9,5%  |

**Calibração** (`npm run bench:rotas -- --calibrate`, grade 3 × 3): ganho médio
no p95 entre +26,9% e +28,4% em todas as combinações; a escolhida (peso 0,5,
escala 0,5 s) foi a melhor. O ótimo é plano, então a escolha não é frágil.

**A heurística nos cinco níveis do agente** (`--teacher`: frações arredondadas
para 0, ¼, ½, ¾ ou 1, como o agente decide). É o professor da imitação da
rodada 2, e mede igual à heurística contínua (todos os intervalos incluem 0):
o espaço de ação do agente não é o que limita.

| Cenário                          | ganho no p95 sobre a heurística (IC 95%) | seeds melhores |
| -------------------------------- | ---------------------------------------- | -------------- |
| Normal                           | −0,0% (−0,1% a +0,1%)                    | 5 de 10        |
| Esteira com alternativa quebrada | +0,1% (−0,4% a +0,5%)                    | 4 de 10        |
| Pico de pedidos                  | −0,4% (−1,9% a +1,1%)                    | 4 de 10        |
| Falhas automáticas               | +1,0% (−1,0% a +3,0%)                    | 7 de 10        |

### Agente de reforço (PPO): rodadas de ajuste nas seeds de validação

**Critério de sucesso, fixado antes de treinar** (contra a heurística, pares
seed × cenário): p95 do ciclo melhor em pelo menos 7 de cada 10 pares; ganho
médio no p95 de pelo menos 3% com o IC 95% acima de 0; sem perda de vazão; em
nenhum cenário o p95 significativamente pior; nem o p99 nem a idade máxima de um
pacote significativamente piores, no total ou em algum cenário. Prazo: até 3
rodadas de ajuste de no máximo 2 milhões de decisões cada. Recompensa por
segundo: −(0,01 × pacotes no galpão + 0,05 × pacotes com mais de 60 s); ação: um
nível de 0 a 4 por escolha (fração = nível ÷ 4); observação: 93 valores
(ocupação e fila de cada esteira, desvios por robô, filas de entrada, frações
atuais, pico de pedidos, docas bloqueadas).

Retorno médio de referência por episódio (a mesma recompensa, 40 seeds de
treino por cenário, `bench/retornos.ts`): estática −4.450, heurística −2.671.

![Curvas de aprendizado](curvas-rl.svg)

**Rodada 1: PPO a partir de pesos aleatórios** (2M decisões, 69,7 min, 478
decisões/s, 16 ambientes, taxa 3e-4, entropia 0,01). Retorno de treino nos últimos
200 episódios: −5.827, pior que o estático. A política aleatória do começo espalha pacotes ao
acaso a cada segundo, e 2M decisões não bastaram nem para chegar ao estático.

| Cenário                          | p95 (heurística → agente) | ganho no p95 (IC 95%)       | seeds melhores |
| -------------------------------- | ------------------------- | --------------------------- | -------------- |
| Normal                           | 36,7 s → 45,2 s           | −23,0% (−24,0% a −22,0%)    | 0 de 10        |
| Esteira com alternativa quebrada | 46,5 s → 116,6 s          | −152,0% (−176,7% a −127,3%) | 0 de 10        |
| Pico de pedidos                  | 121,6 s → 194,2 s         | −60,1% (−69,7% a −50,5%)    | 0 de 10        |
| Falhas automáticas               | 163,6 s → 218,2 s         | −35,5% (−53,8% a −17,2%)    | 0 de 10        |

No total, −67,6% (IC −85,6% a −49,7%), 0 de 40 pares: nenhum item do critério.

**Rodada 2: imitação da heurística + PPO.** A rede começa imitando o professor
(a heurística nos cinco níveis do agente, que mede igual à heurística): 400
episódios em seeds de treino, 216 mil passos, 189 s; em episódios separados ela
acerta 97,7% dos níveis e as cinco escolhas de uma vez em 90,2% dos segundos.
Depois, 10 atualizações só do crítico e PPO por 2M decisões (69,0 min, 483
decisões/s; taxa 1e-4, entropia 0,001, clip 0,1). Retorno de treino nos últimos
200 episódios: −2.746 (heurística: −2.671).

| Cenário                          | Só imitada: ganho no p95 (IC 95%) | seeds melhores | Imitação + PPO: ganho no p95 (IC 95%) | seeds melhores |
| -------------------------------- | --------------------------------- | -------------- | ------------------------------------- | -------------- |
| Normal                           | +0,0% (−0,1% a +0,2%)             | 4 de 10        | +0,1% (−0,0% a +0,1%)                 | 7 de 10        |
| Esteira com alternativa quebrada | +0,4% (−0,1% a +0,8%)             | 7 de 10        | −0,2% (−0,4% a +0,1%)                 | 3 de 10        |
| Pico de pedidos                  | +4,1% (+2,4% a +5,9%)             | 9 de 10        | +3,9% (+2,3% a +5,6%)                 | 9 de 10        |
| Falhas automáticas               | +1,8% (+0,2% a +3,5%)             | 7 de 10        | +3,2% (+0,1% a +6,3%)                 | 7 de 10        |
| **Total (40 pares)**             | **+1,6% (+0,8% a +2,3%)**         | **27 de 40**   | **+1,8% (+0,8% a +2,7%)**             | **26 de 40**   |

| Item do critério                        | Só imitada  | Imitação + PPO |
| --------------------------------------- | ----------- | -------------- |
| p95 melhor em pelo menos 28 de 40 pares | não (27)    | não (26)       |
| ganho médio ≥ 3% com IC acima de 0      | não (+1,6%) | não (+1,8%)    |
| sem perda de vazão                      | sim (+0,3%) | sim (+0,2%)    |
| p95 não piora em nenhum cenário         | sim         | sim            |
| p99 não piora                           | sim (+1,8%) | sim (+2,4%)    |
| idade máxima não piora                  | sim (+3,0%) | sim (+3,2%)    |

As duas **quase passaram**: cumprem 7 dos 9 itens e ficam abaixo dos dois
limiares de ganho, que não mudam. O PPO acrescentou +0,2 ponto à imitação no
ganho médio, dentro do ruído. Os ganhos se concentram nos cenários congestionados
(pico, falhas automáticas), onde a idade máxima de um pacote também cai (152 → 141
s no pico, 337 → 303 s nas falhas).

**A rede só imitada é reproduzível bit a bit.** Refazer as demonstrações e a
imitação do zero dá o mesmo ONNX, byte a byte (sha256 `c5e09a8c37a33bf2`), o
que foi conferido em três execuções independentes:
`ai/.venv/Scripts/python ai/check_imitation.py` (cerca de 3 min, código de saída
1 se diferir). Paridade ONNX × PyTorch das três redes: diferença máxima de
1,9e-6 nos logits, mesmas ações.

**Por que a imitada supera o próprio professor? Não explicado.** A hipótese era
que a rede suaviza as decisões e oscila menos no congestionamento
(`npm run bench:oscilacao`, por minuto simulado, somando as 5 escolhas, média de
10 seeds):

| Cenário                          | Mudanças de nível por minuto: professor → só imitada → imitação + PPO | Heurística com suavização 0,15 |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------ |
| Normal                           | 2,4 → 1,9 → 3,4                                                       | 0,4                            |
| Esteira com alternativa quebrada | 8,0 → 6,4 → 8,0                                                       | 4,9                            |
| Pico de pedidos                  | 31,0 → 24,6 → 24,2                                                    | 16,5                           |
| Falhas automáticas               | 25,4 → 19,8 → 21,9                                                    | 13,8                           |

A imitada oscila cerca de 20% menos que o professor no congestionamento, mas isso
não acompanha o ganho seed a seed (Pearson −0,41 no pico, +0,13 nas falhas). O
**teste causal**, só como análise (a heurística oficial não mudou): com
suavização 0,15 em vez de 0,3, a heurística passa a mexer na divisão bem menos que
a imitada, e o p95 não melhora em nenhum cenário (normal −0,0%, pico −0,1%,
falhas −0,3%, todos com IC incluindo 0; esteira −0,7%, IC −1,1% a −0,3%).
Oscilar menos não produz o ganho.

**Candidata principal para as seeds de teste** (registrada em 2026-10-06, antes de
qualquer uso das seeds de teste, só com a validação): **a rede da rodada 2
(imitação + PPO)**. Motivos: maior ganho médio no p95 na validação (+1,8% contra
+1,6% da só imitada), melhor p99 (+2,4% contra +1,8%) e melhor idade máxima
(+3,2% contra +3,0%), sem piora significativa em nenhum cenário; e é o método
completo da rodada (a só imitada é a comparação declarada, para medir o que o
PPO acrescentou). Nenhuma das duas cumpriu o critério na validação, então a
expectativa é que a heurística continue sendo a política oficial. A passada única
nas seeds de teste mede as 4 políticas juntas (estática, heurística, só imitada e
imitação + PPO), com o critério aplicado sem mudança às duas redes. A rodada 3
não foi usada: o PPO acrescentou +0,2 ponto à imitação em 2M decisões, longe dos
limiares.

**Política oficial: heurística, decidida na validação.** A passada no teste é só
para reportar os números finais das 4 políticas e do detector; o resultado do
teste não muda essa decisão. (Registrado em 2026-10-06, antes de rodar o teste.)

### Resultado final nas seeds de teste (passada única)

Uma única passada nas seeds 30.001 a 30.010, depois dos registros acima, com as 4
políticas juntas e o detector (`npm run bench:rotas -- --set test --final --rl
rodada2-imitacao,rodada2` e `npm run bench:manutencao -- --set test --final`).

**Ganho no p95 do ciclo sobre o roteamento estático** (IC 95%; seeds melhores em
10):

| Cenário                          | Heurística                  | Só imitada                  | Imitação + PPO              |
| -------------------------------- | --------------------------- | --------------------------- | --------------------------- |
| Normal                           | +1,7% (+1,2% a +2,2%) 10    | +1,7% (+1,2% a +2,1%) 10    | +1,7% (+1,2% a +2,1%) 10    |
| Esteira com alternativa quebrada | +54,0% (+52,3% a +55,6%) 10 | +54,1% (+52,4% a +55,7%) 10 | +53,8% (+52,3% a +55,3%) 10 |
| Pico de pedidos                  | +34,8% (+33,5% a +36,1%) 10 | +37,6% (+35,3% a +39,9%) 10 | +37,9% (+35,5% a +40,3%) 10 |
| Falhas automáticas               | +21,5% (+13,8% a +29,2%) 10 | +22,9% (+14,9% a +30,9%) 10 | +23,1% (+15,3% a +30,9%) 10 |

p95 do ciclo (estática → heurística): normal 37,4 → 36,8 s; esteira 105,2 → 48,4
s; pico 185,0 → 120,7 s; falhas 202,8 → 155,1 s. Vazão +0,1%, +3,5%, +11,4% e
+10,0%.

**As redes contra a heurística** (o critério):

| Cenário                          | Só imitada: ganho no p95 (IC 95%) | seeds melhores | Imitação + PPO: ganho no p95 (IC 95%) | seeds melhores |
| -------------------------------- | --------------------------------- | -------------- | ------------------------------------- | -------------- |
| Normal                           | −0,0% (−0,1% a +0,1%)             | 4 de 10        | −0,0% (−0,1% a +0,0%)                 | 2 de 10        |
| Esteira com alternativa quebrada | +0,2% (+0,0% a +0,4%)             | 7 de 10        | −0,4% (−0,9% a +0,2%)                 | 3 de 10        |
| Pico de pedidos                  | +4,3% (+1,8% a +6,8%)             | 9 de 10        | +4,7% (+1,5% a +7,9%)                 | 9 de 10        |
| Falhas automáticas               | +1,8% (+0,3% a +3,4%)             | 8 de 10        | +2,0% (+0,2% a +3,9%)                 | 7 de 10        |
| **Total (40 pares)**             | **+1,6% (+0,7% a +2,4%)**         | **28 de 40**   | **+1,6% (+0,5% a +2,6%)**             | **21 de 40**   |

| Item do critério                        | Só imitada  | Imitação + PPO (a candidata) |
| --------------------------------------- | ----------- | ---------------------------- |
| p95 melhor em pelo menos 28 de 40 pares | sim (28)    | não (21)                     |
| ganho médio ≥ 3% com IC acima de 0      | não (+1,6%) | não (+1,6%)                  |
| sem perda de vazão                      | sim (+0,1%) | sim (+0,0%)                  |
| p95 não piora em nenhum cenário         | sim         | sim                          |
| p99 não piora                           | sim (+1,5%) | sim (+1,3%)                  |
| idade máxima não piora                  | sim (+1,7%) | sim (+1,9%)                  |

Nenhuma rede cumpre o critério no teste. A candidata cumpre 7 dos 9 itens; a só
imitada, 8 (falha só no ganho médio de 3%). O padrão da validação se repete: as
duas ganham da heurística no pico (+4% a +5%) e nas falhas automáticas (+2%), e
empatam onde a heurística já é quase ótima. **A política oficial continua a
heurística**, como registrado antes do teste; a rede da rodada 2 fica no app como
opção experimental da tecla P.

**Detector de manutenção (k = 3, h = 48), seeds de teste** (10 seeds × 30 min):

| O que                                 | Validação        | Teste            |
| ------------------------------------- | ---------------- | ---------------- |
| Precisão                              | 98% (50 de 51)   | 95% (38 de 40)   |
| Recall das quebras com desgaste       | 77% (48 de 62)   | 72% (38 de 53)   |
| Recall de todas as quebras de esteira | 56% (24 súbitas) | 46% (29 súbitas) |
| Antecedência mediana (p10)            | 36 s (10 s)      | 32 s (8 s)       |
| Alarmes falsos por hora no CD inteiro | 0,2              | 0,4              |

Os alarmes que o motor levantou bateram exatamente com a reaplicação do CUSUM
também no teste.

### Manutenção preditiva (sinais simulados)

> Vibração e temperatura vêm de um modelo simples, não de máquinas reais.
> Os números abaixo medem o detector nesse modelo.

`npm run bench:manutencao`: cada seed roda 30 minutos de falhas automáticas uma
vez; os escores de cada segundo ficam guardados, e a grade de k e h reaplica o
CUSUM sobre eles sem simular de novo. Os alarmes que o próprio motor levantou
batem exatamente com essa reaplicação (o benchmark confere e falha se não
baterem). Um alarme é verdadeiro quando sobe enquanto aquela esteira está se
desgastando; uma quebra conta como detectada quando um alarme subiu durante o
desgaste dela (alarme já aceso antes do início não conta).

**Seeds de validação, k = 3, h = 48** (10 seeds × 30 min = 5 h simuladas, 24
motores):

| O que                                 | Resultado                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Precisão                              | 98% (50 de 51 alarmes)                                                                               |
| Recall das quebras com desgaste       | 77% (48 de 62)                                                                                       |
| Recall de todas as quebras de esteira | 56% (48 de 86; 24 foram súbitas, sem aviso)                                                          |
| Antecedência (do alarme à quebra)     | mediana 36 s, p10 10 s                                                                               |
| Alarmes falsos                        | 1 em 5 h simuladas: 0,2 por hora no CD inteiro (≈ 0,01 por motor-hora); aconteceu durante um enrosco |

**Calibração** (grade 7 × 8, ordenada por F1): k = 3, h = 48 deu F1 0,87; com
k = 2 e h = 64, recall 94% mas precisão 77%; com k = 4 e h = 24, precisão 98%,
recall 73%. k e h grandes fazem o alarme esperar a anomalia durar mais que um
enrosco típico, que é o que mantém os alarmes falsos raros.

**O que fica sem aviso** (as 14 quebras com desgaste não detectadas): desgastes
que aparecem forte em **um sinal só** (vibração sem aquecimento, ou o contrário)
e em geral **rápidos**. Com k = 3 e o z de cada sinal limitado a 4, um sinal
sozinho soma no máximo 4/√2 ≈ 2,83 por segundo, abaixo de k: a soma nunca
acumula. É o preço de ignorar pancadas (só vibração) e enroscos curtos.

| Força do desgaste no sinal mais fraco | Detectadas | Duração do desgaste | Detectadas |
| ------------------------------------- | ---------- | ------------------- | ---------- |
| menor que 0,4                         | 20 de 34   | 60 a 100 s          | 13 de 22   |
| de 0,4 a 0,8                          | 15 de 15   | 100 a 140 s         | 19 de 23   |
| 0,8 ou mais                           | 13 de 13   | 140 a 180 s         | 16 de 17   |

Mediana da força no sinal mais fraco: 0,14 nas perdidas, 0,50 nas detectadas;
duração mediana: 84 s nas perdidas, 128 s nas detectadas.

**Medido ao construir o detector** (mesmas seeds):

| Versão do detector                                     | Resultado                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Modelo nominal fixo do motor                           | melhor F1 0,75 (precisão 64%), ótimo na borda da grade                                               |
| + filtro de Kalman que aprende o normal de cada motor  | precisão até 69%: todos os 29 alarmes falsos (k = 1, h = 8, 4 seeds) de 2 a 16 s depois de um reparo |
| + ressincronizar a temperatura quando o motor religa   | 100% de precisão e de recall: o problema tinha ficado fácil demais                                   |
| + quebras súbitas, desgaste fraco, pancadas e enroscos | o compromisso real acima (ótimo no meio da grade)                                                    |

### Treino no mesmo motor

| O que                                                   | Resultado                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Episódio de 10 min (40 robôs), motor compilado pelo tsx | 11 s                                                                                   |
| O mesmo, build do esbuild sem `keepNames`               | 1,9 s (5,7×), mesmos resultados bit a bit                                              |
| Ida e volta do protocolo binário (Python ↔ Node)        | 0,05 ms                                                                                |
| Decisões por segundo no treino (16 ambientes)           | cerca de 490                                                                           |
| Fidelidade Python ↔ TypeScript                          | mesma impressão digital, medidas e recompensas (cenários esteira e falhas automáticas) |

Por que não escala mais: 8 processos simulando ao mesmo tempo ficam 2,4× mais
lentos cada (cache e memória da máquina), e o passo em lote espera o ambiente
mais lento a cada decisão.

### O agente no app

| O que                                        | Resultado                                                       |
| -------------------------------------------- | --------------------------------------------------------------- |
| Uma decisão no Node (onnxruntime-web, WASM)  | 0,03 ms de inferência + 0,003 ms para montar a observação       |
| Código do worker                             | 101 kB (89 kB na Fase 3)                                        |
| Runtime da rede, baixado só ao escolher a IA | 71 kB de JavaScript + 14,2 MB de WebAssembly (3,7 MB com gzip)  |
| Paridade ONNX × PyTorch                      | mesmos logits até 1e-4 e mesmas ações em 8 observações de prova |

O WebAssembly é a variante só de CPU: a variante com WebGPU tinha 28 MB, e uma
rede de 128 × 128 não precisa de GPU. O worker passou a ser um módulo ES; antes
ele embutia o runtime inteiro (510 kB) porque o formato IIFE não separa
importações dinâmicas.

### Conferência por mutação

| Especificação | O que muda de propósito                                                                                   | Pegas pelos testes |
| ------------- | --------------------------------------------------------------------------------------------------------- | ------------------ |
| manutenção    | desgaste antes das quebras, sinais, ressincronização, aprendizado do filtro, teto do z, CUSUM, checkpoint | 9 de 9             |

Com as especificações anteriores: 39 de 39 na execução completa, em 14 minutos,
com o treino da IA rodando ao mesmo tempo; a mutação dos agregados, criada
depois, foi pega à parte (40 de 40). Uma rodada que passa de 5× o tempo da linha
de base é encerrada e conta como pega: um mutante tinha transformado uma espera
num laço infinito.

### No navegador e no motor

**Chromium (build de produção):** o app abre com a heurística (rótulo e snapshots
desde o primeiro segundo) e o painel <kbd>K</kbd> a compara ao vivo com a cópia
estática desde 0:00; <kbd>P</kbd> passa por IA → estático → heurística; a rede da
rodada 2 carrega em 0,3 s (servidor local) e decide em 0,8 ms em média no worker
(observação, inferência e resposta assíncrona); <kbd>0</kbd> mostra o halo do
motor indo de ciano a vermelho; nenhum erro de console e nenhuma requisição com
erro.

**Benchmark do motor** (`npm run bench:motor`, mesma máquina): 4.187 passos/s com 40
robôs (4.231 na Fase 3), dentro do ruído; sem robôs, 1,10 milhão de passos/s.

**O gate do CI pegou uma regressão real.** No PR, o motor sem robôs ficou 12,0%
mais lento que a `main` (10,2% na rodada de confirmação; o limite é 10%). Medido
por partes, numa cópia descartável: era o monitoramento dos motores (24 motores,
uma vez por segundo simulado, cerca de 185 ns cada), invisível com robôs mas 7% a
9% de um passo sem robôs, que leva cerca de 1 µs. Ele não podia ficar mais barato
sem mudar os sinais (e invalidar a calibração e o teste do detector). A
correção foi em outro ponto do mesmo caminho: as agregações do mundo (fila,
pacotes nas esteiras etc.) eram recontadas a cada passo, percorrendo todos os
pacotes, e só são lidas pelo gravador, pelo snapshot e pelos testes; agora são
contadas na primeira leitura de cada passo. Resultado: sem robôs, cerca de 15% mais
rápido que a `main` na mesma máquina (1,07 milhão contra 0,93 milhão de passos/s),
com impressões digitais idênticas bit a bit em três mundos de referência (com e sem
robôs, política externa, falhas automáticas e desgaste) e uma mutação nova pega
(agregados não recontados depois de restaurar um checkpoint).

**Testes:** 185 em 25 arquivos ao fim da fase (141 em 18 ao fim da Fase 3), mais
2 testes de fidelidade em Python (`ai/test_fidelity.py`) e a conferência da
imitação (`ai/check_imitation.py`).

---

## Fase 4b — gargalo explicado e manutenção agendada

### Protocolo (registrado antes de qualquer medida da 4b)

Registrado em 2026-10-06, antes de rodar qualquer medida desta fase.

- **Seeds de validação:** 20.001 a 20.010, as mesmas da Fase 4. Nelas, e só
  nelas, saem o prazo da agenda de manutenção e os limiares do detector de
  gargalo.
- **Seeds de teste novas:** 30.011 a 30.020, nunca usadas antes, para a
  avaliação final da 4b, numa passada única (`--final`). As seeds 30.001 a
  30.010 já serviram ao teste da Fase 4 e não entram aqui. O resultado do teste
  é só reportado: nenhum parâmetro muda depois dele.
- **Prazo da agenda:** a janela entre o alarme e o início da manutenção sai de
  um percentil baixo da antecedência medida na validação (p10 ou p20, com a
  escolha justificada pelos números da validação), não da mediana. O valor é o
  percentil arredondado para baixo, em segundos. Regra da escolha, fixada antes
  de medir: fica o percentil com menos quebras enquanto a manutenção esperava;
  no empate, o que evita mais falhas; no empate, o prazo menor.
- **Medidas da agenda** (pareadas por seed, com e sem agenda): quebras
  evitadas (entre as que tinham desgaste e entre todas), quebras que
  aconteceram enquanto a manutenção esperava, manutenções sem desgaste
  encontrado por hora, tempo de esteira parada e p95 do ciclo. Premissa
  declarada: a manutenção planejada leva 30 s, contra 60 a 90 s de uma quebra;
  os números saem também com 45 e 60 s.
- **Medidas do detector de gargalo:** em ensaios controlados (uma falha
  aplicada de cada vez, numa operação sem outras falhas, comparada com a mesma
  seed sem a falha): das falhas que formam fila, quantas ele aponta e em quanto
  tempo; o **percentual de causas corretas**, comparando a causa explicada com
  a falha que o injetor realmente aplicou; e quantos gargalos ele aponta por
  hora sem nenhuma falha aplicada. Uma falha "forma fila" quando deixa pelo
  menos 10 pacotes a mais esperando (média de 10 s) do que a mesma seed sem
  ela, enquanto dura ou nos 30 s seguintes. Regra da escolha dos limiares,
  fixada antes de medir: entre as combinações com no máximo um gargalo por
  hora sem falha aplicada, a que aponta com a causa certa (no primeiro aviso)
  o maior número de falhas que formaram fila; no empate, menos gargalos sem
  falha; depois, a menor mediana até apontar; depois, os valores atuais.

### Agenda de manutenção: o prazo (seeds de validação)

`npm run bench:agenda -- --calibrate`: 30 minutos de falhas automáticas por seed,
roteamento pela heurística, com e sem a agenda. Sem a agenda, o alarme pegou 47
quebras com desgaste; a antecedência delas (do alarme à quebra) teve **p10 de
11,6 s e p20 de 15,3 s**. O prazo testado foi o percentil arredondado para baixo:
11 s e 15 s.

Os dois deram resultados idênticos (as mesmas falhas evitadas, nenhuma quebra
durante a espera nos dois, a mesma espera mediana de 1 s e p90 de 8 s). O prazo
quase nunca é o limite: a espera é o tempo de esvaziar a esteira (até 10 s) ou o
fim de um pico de pedidos. Pela regra fixada antes de medir (no empate, o prazo
menor), ficou o **p10: 11 s**.

### Achado: com a agenda, o modo automático aplicava mais falhas

A primeira comparação com e sem a agenda deu números estranhos: com manutenção
de 60 s, a agenda **piorava** as entregas (−3,8%, significativo). Contando as
falhas que o modo automático aplicou em cada braço, nas mesmas 10 seeds: **67
desgastes sem a agenda, 91 com ela (+36%)**. O modo automático limita as falhas
simultâneas a duas, e um desgaste ocupa uma vaga até a quebra terminar; cortado
pela manutenção, liberava a vaga cerca de um minuto antes, e o simulador injetava
mais falhas no mundo com agenda. A comparação punia a agenda com uma carga maior.

Correção: a quebra evitada continua ocupando a vaga até quando teria terminado.
Depois disso, os dois braços de cada seed recebem exatamente as mesmas falhas (67
desgastes, 45 picos, 54 defeitos de robô e 43 docas bloqueadas em cada um). Com a
agenda desligada nada muda (as impressões digitais de referência não se moveram).

### Agenda de manutenção: resultado nas seeds de validação

`npm run bench:agenda` (manutenção de 30 s; prazo de 11 s):

| O que                                          | Resultado                                                     |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Quebras evitadas, entre as que tinham desgaste | **76% (48 de 63)**                                            |
| Quebras evitadas, entre todas as de esteira    | 55% (48 de 87; 24 eram súbitas, sem aviso possível)           |
| Quebras enquanto a manutenção esperava         | **0**                                                         |
| Manutenções sem desgaste (alarme falso)        | 1 em 5 h simuladas (0,2 por hora no CD)                       |
| Espera do alarme ao início                     | mediana 1 s, p90 8 s                                          |
| p95 do ciclo, com × sem a agenda               | **+34,9% (IC 95% +25,0% a +44,8%), melhor em 10 de 10 seeds** |
| Ciclo médio                                    | +27,2% (+16,5% a +38,0%), 10 de 10                            |
| Entregas                                       | +7,1% (+4,6% a +9,7%), 10 de 10                               |
| Tempo de esteira parada                        | −30,2% (IC −24,0% a −36,5%): 6.259 → 4.355 esteira·s          |
| Pacote·segundo em esteira parada               | −35,7% (IC −25,1% a −46,2%): 41.088 → 26.116                  |

**A premissa da duração decide o tamanho do ganho:**

| Manutenção planejada | p95 do ciclo                    | Entregas              | Tempo de esteira parada |
| -------------------- | ------------------------------- | --------------------- | ----------------------- |
| 30 s                 | +34,9% (+25,0% a +44,8%), 10/10 | +7,1% (+4,6% a +9,7%) | −30,2%                  |
| 45 s                 | +23,6% (+13,2% a +33,9%), 10/10 | +5,3% (+2,9% a +7,6%) | −18,5%                  |
| 60 s                 | +11,1% (−0,7% a +22,8%), 9/10   | +2,7% (+0,6% a +4,9%) | −6,7%                   |

Mesmo com 60 s, a duração da quebra mais curta, a agenda ainda reduz o tempo
parado (a quebra dura 75 s em média e o desvio esvazia parte das esteiras antes).

**O desvio antes da parada nem sempre esvazia a esteira.** Das 21 paradas em
esteiras que a rota consegue esvaziar, 43% começaram com a esteira vazia (espera
mediana de 8 s); nas 28 sem outro caminho para o fluxo, a parada começa 1 s
depois do alarme e 11% estavam vazias por acaso. A fila na saída faz uma esteira
esvaziar mais devagar do que o comprimento dela prevê.

### Detector de gargalo: calibração (seeds de validação)

`npm run bench:gargalo -- --calibrate`: em cada uma das 10 seeds, uma rodada de
30 minutos sem nenhuma falha e 34 ensaios com uma falha só, aplicada aos 150 s
(cada uma das 24 esteiras, cada uma das 6 docas, um pico de pedidos e 3 robôs),
roteamento pela heurística. Das 340 falhas aplicadas, **293 formaram fila** (pelo
menos 10 pacotes a mais esperando do que sem a falha); os 30 defeitos de robô não
formaram nenhuma (40 robôs dão conta sem o robô parado).

Grade de 27 combinações de três limiares (fila mínima 6, 8 ou 12 pacotes;
crescimento mínimo 4, 6 ou 10 por minuto; uso mínimo 70%, 80% ou 90%):

| Fila mínima | Uso mínimo | Apontadas  | Causa correta no 1º aviso | Gargalos sem falha (por hora) |
| ----------- | ---------- | ---------- | ------------------------- | ----------------------------- |
| 6           | 70%        | 292 de 293 | 262 (90%)                 | 16,8                          |
| 6           | 90%        | 285        | 284 (100%)                | 3,7                           |
| 8           | 70%        | 291        | 262 (90%)                 | 6,2                           |
| 8           | 90%        | 278        | 277 (100%)                | 1,7                           |
| **12**      | **70%**    | **291**    | **291 (100%)**            | **0,8**                       |
| 12          | 90%        | 275        | 273 (99%)                 | 0,4                           |

O crescimento mínimo não fez diferença com fila mínima de 12 (4, 6 e 10 por
minuto deram o mesmo resultado). Pela regra fixada antes de medir (no máximo um
gargalo por hora sem falha; depois, o maior número de falhas apontadas com a causa
certa; depois, os valores atuais), ficaram **fila mínima de 12 pacotes, uso mínimo
de 70% e crescimento mínimo de 6 por minuto**.

### Achado: a fila contada só um passo à frente

A primeira calibração deixou passar a quebra das Esteiras 15, 16 e 18 (a espinha
do sorter), com 244 a 296 pacotes a mais esperando. A causa: um pacote parado era
contado na fila da esteira em que ele queria entrar, só um passo à frente. A
Esteira 16 (6 m, cabem 11 pacotes) parada recebia os 11 pacotes da esteira
anterior, cheia e parada atrás dela; as centenas de pacotes mais atrás contavam
para essa esteira anterior, uma vítima, que o detector corretamente ignora. A
fila do gargalo de verdade nunca passava de 11 e não chegava ao mínimo de 12.

Correção: a espera segue a corrente de esteiras paradas até a raiz (o primeiro
recurso parado, uma doca, ou uma esteira cheia que ainda anda). Um teste confere,
a cada segundo de três execuções caóticas (inclusive o teste de carga), que todo
pacote esperando do motor é contado exatamente uma vez. Depois da correção, as
três quebras passaram a ser apontadas: de 285 para 291 apontadas com a causa
certa.

### Detector de gargalo: resultado nas seeds de validação

| O que                                                        | Resultado                 |
| ------------------------------------------------------------ | ------------------------- |
| Falhas que formaram fila                                     | 293 de 340                |
| Apontadas pelo detector                                      | **99% (291 de 293)**      |
| Tempo até apontar                                            | mediana 6 s, p90 28 s     |
| **Causa correta** (o primeiro aviso nomeia a falha aplicada) | **100% (291 de 291)**     |
| Causa correta, em todos os segundos de aviso                 | 98% (17.484 de 17.768 s)  |
| Falhas sem fila formada com gargalo apontado                 | 0 de 47                   |
| Gargalos apontados sem nenhuma falha aplicada                | 4 em 4,8 h (0,8 por hora) |

Por tipo de falha: esteira quebrada 221 de 223 apontadas, todas com a causa
certa; doca bloqueada 60 de 60; pico de pedidos 10 de 10.

As duas falhas não apontadas foram quebras da Esteira 12 que deixaram 11 e 18
pacotes a mais: filas pequenas, abaixo do mínimo. Os quatro gargalos sem falha
duraram de 6 a 8 s cada: as Docas 2 e 3 e a Esteira 9 saturadas por um acúmulo
momentâneo de pedidos, com a causa "a demanda passa da capacidade". São
saturações reais e curtas, não erros de leitura.

**Leitura honesta do 100%.** Na maioria dos ensaios o gargalo é o próprio recurso
parado, e a causa vem do estado dele. As partes difíceis da explicação (o fluxo
desviado de outra esteira e o pico de pedidos) aparecem nos avisos seguintes e
nos ensaios de pico; elas entram no número "em todos os segundos de aviso" (98%).

### Resultado final nas seeds de teste novas (passada única)

Uma única passada nas seeds 30.011 a 30.020, depois de todas as calibrações e da
conferência por mutação (`npm run bench:agenda -- --set teste-4b --final` e
`npm run bench:gargalo -- --set teste-4b --final`). Nada mudou depois dela.

**Agenda de manutenção** (manutenção de 30 s; prazo de 11 s):

| O que                                          | Validação                       | Teste                               |
| ---------------------------------------------- | ------------------------------- | ----------------------------------- |
| Quebras evitadas, entre as que tinham desgaste | 76% (48 de 63)                  | **74% (43 de 58)**                  |
| Quebras evitadas, entre todas as de esteira    | 55% (48 de 87)                  | 51% (43 de 85; 27 súbitas)          |
| Quebras enquanto a manutenção esperava         | 0                               | **1**                               |
| Manutenções sem desgaste (alarme falso)        | 1                               | 0                                   |
| Espera do alarme ao início                     | mediana 1 s, p90 8 s            | mediana 1 s, p90 8 s                |
| p95 do ciclo, com × sem a agenda               | +34,9% (+25,0% a +44,8%), 10/10 | **+25,0% (+13,4% a +36,5%), 10/10** |
| Ciclo médio                                    | +27,2% (+16,5% a +38,0%)        | +20,8% (+11,7% a +30,0%)            |
| Entregas                                       | +7,1% (+4,6% a +9,7%)           | +6,2% (+3,7% a +8,8%)               |
| Tempo de esteira parada                        | −30,2%                          | −27,7% (6.035 → 4.400 esteira·s)    |
| Pacote·segundo em esteira parada               | −35,7%                          | −30,8% (41.375 → 28.744)            |

Com manutenção de 45 s, o p95 melhora +16,6% (+8,7% a +24,6%); com 60 s, +5,8%
(−0,1% a +11,8%), e o intervalo passa a incluir zero. As falhas aplicadas foram as
mesmas nos dois braços de cada seed (64 desgastes, 48 picos, 64 defeitos de robô e
36 docas bloqueadas em cada um).

Nessas seeds, sem a agenda, a antecedência dos alarmes teve p10 de 9,2 s e p20 de
20,7 s (40 quebras com desgaste detectadas): o p10 ficou abaixo do prazo de 11 s
calibrado na validação, o que combina com a única quebra durante a espera.

**Detector de gargalo** (ensaios controlados; um ensaio de robô ficou de fora
porque o robô estava recarregando):

| O que                                                        | Validação                 | Teste                    |
| ------------------------------------------------------------ | ------------------------- | ------------------------ |
| Falhas que formaram fila                                     | 293 de 340                | 291 de 339               |
| Apontadas pelo detector                                      | 99% (291 de 293)          | **99% (289 de 291)**     |
| Tempo até apontar                                            | mediana 6 s, p90 28 s     | mediana 6 s, p90 26 s    |
| **Causa correta** (o primeiro aviso nomeia a falha aplicada) | 100% (291 de 291)         | **100% (289 de 289)**    |
| Causa correta, em todos os segundos de aviso                 | 98%                       | 98% (16.780 de 17.074 s) |
| Falhas sem fila formada com gargalo apontado                 | 0 de 47                   | 0 de 48                  |
| Gargalos apontados sem nenhuma falha aplicada                | 0,8 por hora (4 em 4,8 h) | **0 em 4,8 h**           |

Por tipo de falha, no teste: esteira quebrada 219 de 221 apontadas, todas com a
causa certa; doca bloqueada 60 de 60; pico de pedidos 10 de 10. As duas não
apontadas: uma quebra da Esteira 12 (11 pacotes a mais) e uma da Esteira 4 (31 a
mais), em que a rota desviou o fluxo e a fila se espalhou por outros caminhos sem
que nenhum recurso saturasse.

### Conferência por mutação

`npm run mutate`: **63 de 63** mutações pegas. As 23 novas: 12 da agenda de
manutenção (ignorar o alarme, não desviar a rota, não esperar esvaziar ou a
demanda cair, ignorar o prazo, não corrigir o desgaste, a esteira não voltar,
quebra durante a espera não notada, a quebra evitada liberar cedo a vaga do
limite de falhas, a esteira quebrar durante a manutenção, checkpoint sem a
agenda, decidir no mesmo segundo do alarme) e 11 do detector e da contagem de
filas (a fila contada só um passo à frente, que foi o bug real; esteira parada,
doca e pilha de entrada fora da conta; vítima apontada como gargalo; esteira
parada exigindo fila crescendo; pico contado só enquanto ativo; sem a causa de
fluxo desviado; o pior ponto pelo crescimento; aviso que não se segura; a
própria quebra como causa apenas provável). Uma sobreviveu na primeira rodada
(decidir no mesmo segundo do alarme): o teste de ponta a ponta passou a conferir
que nenhuma manutenção começa no segundo do alarme real.

### No navegador e nos testes

No Chromium, com o build de produção: o cartão "Gargalo agora" e o anel âmbar na
quebra da Esteira 9; o cartão acompanhando a viagem no tempo (some 20 s antes da
quebra, volta 10 s depois); um desgaste terminando em falha evitada (alarme,
agendamento e "Falha evitada" no feed, esteira e motor ciano, painel K com a
contagem); um celular de 390 px sem sobreposição entre métricas, cartão, feed e
controles; nenhum erro de console. O benchmark do motor não mudou (gravação com
40 robôs: −0,8%, dentro do ruído).

**Testes:** 224 em 29 arquivos (185 em 25 ao fim da Fase 4), entre eles as
impressões digitais de referência de quatro execuções, tiradas antes da 4b: com a
agenda desligada, o motor das fases anteriores não mudou um bit.

---

## Fase 5 — laboratório de cenários e demanda real

### Laboratório: demanda da Olist × constante

Seeds 50.001 a 50.010, segunda-feira, a mesma quantidade de pedidos no dia nos
dois cenários (3,6 pedidos/s em média), 40 robôs, heurística, agenda de
manutenção ligada, sem falhas automáticas (`npm run bench:lab`):

| Medida               | Constante | Olist     | Olist − constante (IC 95%)     |
| -------------------- | --------- | --------- | ------------------------------ |
| Tempo de ciclo médio | 31,8 s    | 55,9 s    | +24,1 s (+22,2 a +26,0), 10/10 |
| p95 do ciclo         | 36,8 s    | 120,1 s   | +83,3 s (+74,6 a +91,9), 10/10 |
| Vazão                | 217,8/min | 208,3/min | −9,5 (−11,0 a −7,9), 10/10     |
| Uso das esteiras     | 34,0%     | 32,8%     | −1,2 (−1,4 a −1,0)             |
| Uso das docas        | 69,8%     | 64,4%     | −5,4 (−6,0 a −4,8)             |
| Uso dos robôs        | 63,5%     | 54,5%     | −9,0 (−13,0 a −4,9)            |

Os pedidos são os mesmos no total; muda a distribuição no dia. Na segunda-feira
da Olist a demanda passa da média das 9h às 23h e chega a 1,66 vez a média às 21h
(6,0 pedidos/s), acima do que o galpão escoa: a fila, quase zero até as 9h, cresce
o dia todo (seed 50.001: 67 pacotes esperando às 10h, 238 às 16h, 296 às 22h) e o
dia termina com mais de 200 pacotes no galpão. Por isso a vazão do dia cai e o
p95 do ciclo fica 3,3 vezes maior. É o tipo de efeito que a demanda constante das
fases anteriores escondia.

**Achado ao escrever este resultado.** A primeira versão desta tabela comparava a
taxa constante com a segunda-feira da Olist sem perceber que a segunda tem 15,7%
mais pedidos que a média da semana (o perfil tem média 1 na semana, não em cada
dia): a diferença misturava volume e formato (p95 +213 s). O laboratório passou a
reescalar o perfil para o dia simulado ter a taxa escolhida como média
(`dayScaled`, testado), e o campo do painel diz "média do dia".

### Protocolo das causas com falhas automáticas (registrado antes de medir no teste)

Pedido de 2026-10-07: a precisão das causas do gargalo (98% a 100%, Fase 4b) foi
medida com uma falha de cada vez; medir também no cenário de falhas automáticas,
com falhas simultâneas, e reportar mesmo que caia.

- **O detector é o da 4b, sem mudança** (`DEFAULT_BOTTLENECK`). Nada nele muda
  por causa desta medida.
- **Cenário:** 1 h por seed, roteamento pela heurística, falhas automáticas como
  no app (até duas ao mesmo tempo, mais os desgastes), agenda de manutenção
  desligada (as paradas dela são decisões, não falhas do injetor).
- **A verdade, por contrafactual exato:** para cada falha aplicada, a mesma seed
  roda de novo a partir de um checkpoint anterior a ela, com só ela suprimida (é
  sorteada como sempre, mas não acontece, e ocupa o lugar dela no limite de falhas
  até quando teria acabado, então o resto do modo automático segue igual), e as
  filas são medidas a cada segundo, como na gravação. O replay sem supressão
  reproduz a gravação bit a bit (testado).
- **Explicação:** segundos seguidos com o mesmo gargalo e a mesma causa (o que a
  tela mostrou), julgada no seu pior segundo (a maior fila). **Candidatas:** as
  falhas ligadas naquele segundo ou encerradas até **180 s** antes. **Causas:** as
  candidatas cuja remoção tira pelo menos metade da fila do gargalo (e pelo menos
  6 pacotes). Sem nenhuma, a fila é do desenho e da demanda.
- **Certa:** o detector nomeia uma das causas, ou o desenho quando não há
  nenhuma. Defeito de robô nunca é nomeado pelo detector: quando é a única causa,
  a explicação está errada.
- **Medida principal:** percentual de explicações certas, somado nas seeds, com IC
  95% pela variação entre seeds (`pooledShare`). Recortes: pelo número de falhas
  ligadas no segundo julgado (0, 1, 2 ou mais), pela causa dita, pela causa
  verdadeira, e os segundos na tela com fila de pelo menos 12; sensibilidade à
  janela (60 e 600 s) e o controle da janela, reportados ao lado.
- **Teste:** seeds novas 30.021 a 30.030 (`teste-5`), nunca usadas, uma única
  passada depois da conferência por mutação:
  `npm run bench:gargalo-caos -- --set teste-5 --final`.

**Como a janela de 180 s foi escolhida (seeds de validação).** Uma fila sobrevive
à falha que a fez: uma esteira quebrada deixa um acúmulo que leva minutos para
escoar, e metade das causas verdadeiras tinha terminado mais de um minuto antes.
Uma janela curta favoreceria o detector (que só enxerga falhas ligadas); uma
longa demais atribuiria a qualquer falha antiga uma fila que é do galpão inteiro.
O controle: defeito de robô quase nunca forma fila de esteira ou de doca (0%
enquanto ligado). Até 180 s depois do fim, ele aparece como causa no nível do
ruído (no máximo 3,5%, perto da fração de remoções que **aumentam** a fila em
metade, 1% a 3%); a partir daí sobe para 10% a 12%: remover qualquer falha antiga
alivia o galpão, e "a causa" deixa de ser uma falha. A janela é o último ponto
antes disso.

### Causas com falhas automáticas: seeds de validação

`npm run bench:gargalo-caos` (10 seeds, 431 falhas aplicadas: 171 de esteira, 67
de doca, 84 picos, 109 de robô; 1.948 explicações):

| Explicações                               | Causa certa                | IC 95%        |
| ----------------------------------------- | -------------------------- | ------------- |
| Todas                                     | **59,4%** (1.157 de 1.948) | 54,5% a 64,3% |
| Nenhuma falha ligada no segundo julgado   | 43,2% (357 de 826)         | 36,4% a 50,0% |
| Uma falha ligada                          | 68,2% (567 de 831)         | 62,0% a 74,5% |
| Duas ou mais falhas ligadas (simultâneas) | 80,1% (233 de 291)         | 74,9% a 85,2% |
| Segundos na tela (fila ≥ 12)              | 77,0% (16.390 de 21.295 s) | 75,7% a 78,2% |

Pela causa que o detector deu: "quebra desta esteira" 98% (342 de 349); "doca
bloqueada" 100% (109 de 109); "esteira quebrada desvia o fluxo para cá" 83% (95
de 115); "pico de pedidos" 56% (285 de 506); "desenho e demanda" 38% (326 de
869). Com a janela de 60 s, 78,1%; com 600 s, 52,8%.

**Leitura.** A queda em relação aos 98% a 100% da 4b não vem da simultaneidade:
com duas ou mais falhas ligadas o detector acerta 80%, porque a causa está à
vista (a própria falha do recurso). Vem da **memória**: quando nenhuma falha está
ligada, a fila costuma ser a sobra de uma quebra que já terminou, e o detector,
que só olha o estado atual, diz "desenho e demanda" (certo em 38% das vezes) ou
"pico de pedidos" quando houve um pico recente mas a fila é de outra falha.

## Bugs que só apareceram medindo

| Fase | Sintoma medido                                                       | Causa                                                                | Efeito da correção                                               |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | Fila de entrada crescendo em regime normal (297 pacotes em 15 min)   | esteira E9 recebendo 2,7 pacotes/s com capacidade de 2,46            | esteiras a 2,0 m/s: E9 a 81%, fila estável                       |
| 1    | +1 textura na GPU a cada reinício                                    | só a textura do ambiente era liberada, não o render target           | memória estável em 5 reinícios                                   |
| 1    | 433 chamadas de desenho por quadro                                   | um objeto por anel e por peça de caminhão                            | 284                                                              |
| 1    | CPU 4× mais lenta ficava em 49–51 FPS sem reduzir qualidade          | alvo do ajuste automático em 50 FPS                                  | alvo 55: cai para média e volta a 60 FPS                         |
| 2    | Frenagens acima do limite ao alcançar a referência                   | curva de frenagem contínua avaliada tick a tick                      | curva discreta e checagem da referência futura: 0 violações      |
| 2    | Frenagem brusca logo após replanejar                                 | o novo plano mudava a curva na célula seguinte                       | compromisso 2 passos à frente: 0 violações em 8 seeds            |
| 2    | Exceção "célula já reservada"                                        | robô precisando parar numa célula que outro reservaria no futuro     | esse outro também replaneja                                      |
| 2    | 31% das tentativas de planejamento sem caminho                       | estação liberada com o robô ainda em cima                            | 1,3%, e plano 10× mais rápido                                    |
| 3    | Os dois robôs de um par recuavam ao mesmo tempo                      | cada um pedia passagem ao outro na mesma rodada                      | só um recua (teste)                                              |
| 3    | Robôs saindo da frente à toa atrás de um robô com defeito            | o pedido de passagem passava por quem não podia se mover             | nenhum pedido nesses casos (teste)                               |
| 3    | 36 casos de impasse custando 11,8 s de CPU                           | cada tentativa sem caminho esgotava 60 mil estados da busca          | prova no piso: 1,8 s; ~20 ms → ~0,002 ms por tentativa           |
| 3    | Robô restaurado divergindo no último bit                             | a soma da janela de métricas era recalculada ao compactar            | compactação sem recálculo: idêntico bit a bit                    |
| 3    | Checkpoints de 211 KB (326 KB no máximo) numa hora com falhas        | pacotes parados nas entradas gravados com todos os campos            | 16 bytes por pacote intacto: média 122 KB, máximo 172 KB         |
| 3    | Teste de carga perdido ao reiniciar (teste do worker)                | a carga virou entrada gravada e o reinício criava gravação nova      | a carga volta como entrada no tick 0 da nova gravação            |
| 4    | Treino a 170 decisões/s (2M em 3,3 h)                                | o tsx (keepNames) gastava ~75% do episódio num ajudante              | build com esbuild: ~490/s, 2M em cerca de 70 min                 |
| 4    | Detector com 20% a 69% de precisão                                   | modelo fixo do motor: viés de cada motor e da carga                  | filtro de Kalman aprende o normal de cada motor                  |
| 4    | 29 de 29 alarmes falsos logo depois de um reparo                     | o motor que quebrou gasto volta quente (memória térmica)             | o gêmeo ressincroniza a temperatura quando o motor religa        |
| 4    | 100% de precisão e de recall                                         | desgaste sempre forte e nenhum distúrbio no modelo dos sinais        | quebras súbitas, desgaste fraco, pancadas e enroscos             |
| 4    | Conferência por mutação parada por mais de 7 min                     | mutante transformou "espere um desgaste" em laço infinito            | teste com limite; rodada encerrada em 5× a linha de base         |
| 4    | Worker de 89 kB → 510 kB                                             | o formato IIFE embutia o runtime da rede no import dinâmico          | worker em módulo ES: 101 kB, runtime baixado sob demanda         |
| 4    | Motor sem robôs 12% mais lento que a `main` (gate do CI)             | monitoramento dos 24 motores a cada segundo simulado                 | agregados contados só quando lidos: 15% mais rápido que a `main` |
| 4b   | Com a agenda, o modo automático aplicava 36% mais desgastes          | a quebra evitada liberava cedo a vaga do limite de 2 falhas          | a vaga fica ocupada até quando a quebra teria terminado          |
| 4b   | Quebras de esteiras do sorter não apontadas (até 296 pacotes a mais) | fila contada só um passo à frente: a esteira curta não passava de 11 | a espera segue a corrente até a raiz: 285 → 291 apontadas        |
| 4b   | Dois testes antigos passaram de 5 s na suíte completa                | testes novos pesados disputando CPU                                  | testes novos mais leves; 20 s para os dois pesados               |

## Como reproduzir

```bash
npm test             # segurança da frota, desvio, falhas, determinismo
npm run bench        # a tabela de benchmarks do README (todas as partes, com IC 95%)
npm run bench:motor  # benchmark do motor
npm run bench:mapf   # planejamento e episódios sem caminho
npm run bench:vigia  # impasses e defeitos em corredor estreito, com e sem vigia
npm run bench:tempo  # uma hora simulada: memória, checkpoints e seek (cerca de 3 min)
npm run bench:rotas  # roteamento: estática × heurística (--rl <modelo> inclui o agente, --teacher o professor)
npm run bench:manutencao  # detector de manutenção preditiva (--calibrate: grade de k e h)
npm run bench:agenda      # agenda de manutenção com × sem, seed a seed (--calibrate: prazo no p10 e no p20)
npm run bench:gargalo     # detector de gargalo em ensaios controlados (--calibrate: grade de limiares)
npm run bench:gargalo-caos  # causas do gargalo com falhas automáticas simultâneas (contrafactual)
npm run bench:lab    # laboratório de cenários: A × B nas seeds do laboratório
npm run mutate       # conferência por mutação numa cópia temporária (~10 min)
ai/.venv/Scripts/python ai/test_fidelity.py   # o Python e o TypeScript simulam igual
ai/.venv/Scripts/python ai/train.py --name x  # treino PPO (ver o README)
npm run dev          # depois, no console do navegador: __gemeo.benchHeat()
```

As medições de interface (tarefas longas, FPS, memória) usaram o Chromium
via Playwright; `?sim=main` liga a simulação na thread da página para a
comparação.
