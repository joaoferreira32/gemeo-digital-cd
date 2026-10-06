# Gêmeo Digital de Centro de Distribuição

[![CI](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/ci.yml/badge.svg)](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/ci.yml)
[![Deploy](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/deploy.yml/badge.svg)](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/deploy.yml)

**Demo:** https://joaoferreira32.github.io/gemeo-digital-cd/

Simulação 3D em tempo real, no navegador, de um galpão logístico: esteiras,
pacotes, docas, caminhões e uma frota de 40 robôs (AGVs) que se coordenam por
planejamento multiagente, com falhas injetadas e mapa de calor. Toda a execução
é gravada: dá para voltar a qualquer instante, ver o estado exato daquele
momento, continuar dali por outro caminho e exportar o log de eventos. Uma
camada de IA de operações escolhe por onde os pacotes seguem (heurística ou
rede treinada por reforço, comparadas ao vivo com o roteamento estático) e
avisa antes de uma esteira quebrar (manutenção preditiva sobre sinais
simulados). O motor de simulação é determinístico, roda num Web Worker e é
testado sem navegador.

> **Status:** Fase 4 de 6 concluída (IA de operações). Laboratório de cenários e
> modo cinema vêm depois.

## Como rodar

Requer Node.js 20+ (desenvolvido com o 24 LTS).

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # testes do motor (Vitest)
npm run lint         # ESLint + Prettier
npm run build        # build estático em dist/
npm run bench        # benchmark curto do motor (o mesmo do CI)
npm run bench:mapf   # estatísticas do planejamento multiagente
npm run bench:vigia  # impasses e defeitos em corredor estreito, com e sem vigia
npm run bench:tempo  # uma hora simulada: memória, checkpoints e latência do seek (~3 min)
npm run bench:rotas  # roteamento estático × heurística (× IA com --rl <modelo>), seeds de validação
npm run bench:manutencao  # detector de manutenção preditiva, seeds de validação
npm run mutate       # conferência por mutação, numa cópia temporária (~10 min)
```

Treino da IA de roteamento (opcional; o app já traz a rede treinada). Python
3.12 num ambiente virtual próprio, nunca no Python global:

```bash
python -m venv ai/.venv
ai/.venv/Scripts/python -m pip install -r ai/requirements.txt   # Windows (Linux/macOS: ai/.venv/bin/python)
ai/.venv/Scripts/python ai/test_fidelity.py                     # Python e TypeScript simulam igual
ai/.venv/Scripts/python ai/train.py --name teste --steps 100000
npm run bench:rotas -- --rl teste
```

`?sim=main` na URL roda a simulação na thread da página em vez do worker
(usado para comparar).

## Controles

| Ação                   | Mouse / teclado                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Girar                  | arrastar · <kbd>Q</kbd> <kbd>E</kbd>                                                                         |
| Mover                  | botão direito ou <kbd>Shift</kbd> + arrastar · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / setas      |
| Zoom                   | roda do mouse (em direção ao cursor) · <kbd>+</kbd> <kbd>−</kbd>                                             |
| Inclinar               | <kbd>R</kbd> <kbd>F</kbd>                                                                                    |
| Câmeras                | <kbd>1</kbd> aérea · <kbd>2</kbd> chão · <kbd>3</kbd> seguir robô · <kbd>N</kbd> próximo robô                |
| Pausar / velocidade    | <kbd>Espaço</kbd> · <kbd>,</kbd> <kbd>.</kbd> (1×, 4×, 16×)                                                  |
| Falhas                 | <kbd>5</kbd> esteira · <kbd>6</kbd> pico de pedidos · <kbd>7</kbd> robô · <kbd>8</kbd> doca                  |
| Falhas automáticas     | <kbd>9</kbd>                                                                                                 |
| Desgaste numa esteira  | <kbd>0</kbd> (quebra em 1 a 3 min; o halo do motor e o alarme de manutenção avisam antes)                    |
| Roteamento             | <kbd>P</kbd> heurística (padrão) → IA (PPO) → estático; o painel <kbd>K</kbd> compara com o estático ao vivo |
| Mapa de calor          | <kbd>M</kbd> ocupação → tempo de espera → tráfego de robôs → desligado                                       |
| Teste de carga         | <kbd>T</kbd> (taxa de pedidos muito acima da capacidade)                                                     |
| Qualidade gráfica      | <kbd>G</kbd> (desliga o ajuste automático)                                                                   |
| Reiniciar (mesma seed) | <kbd>Shift</kbd> + <kbd>R</kbd>                                                                              |
| Linha do tempo         | arrastar na barra de baixo · <kbd>[</kbd> <kbd>]</kbd> volta / avança 10 s                                   |
| Voltar ao vivo         | <kbd>L</kbd>                                                                                                 |
| Continuar daqui        | <kbd>C</kbd>, <kbd>Espaço</kbd> ou qualquer falha injetada no passado (descarta o que vinha depois)          |
| Painel de operação     | <kbd>K</kbd> (vazão, tempo de ciclo médio e p95, utilização, estados dos robôs, últimos 5 min)               |
| Histórico              | clique num robô, numa esteira ou numa doca                                                                   |
| Exportar               | botões da linha do tempo: eventos em CSV, relatório JSON; "Carregar relatório" reproduz uma execução         |
| Atalhos e legenda      | <kbd>H</kbd>                                                                                                 |

## Arquitetura

```
 página (thread principal)                         Web Worker
 ┌──────────────────────────────┐   comandos    ┌───────────────────────────┐
 │ ui/      HUD, painéis,       │ ────────────► │ worker/  SimHost: relógio │
 │          linha do tempo      │               │          real × velocidade│
 │ link/    FrameBuffer:        │ ◄──────────── │ sim/     Recorder: grava  │
 │          interpola snapshots │  snapshot em  │          entradas e       │
 │ render/  Three.js (só lê)    │  ArrayBuffer  │          checkpoints      │
 └──────────────────────────────┘  transferido  │          World (passo     │
                                 + status 2×/s  │          fixo, seed)      │
                                                └───────────────────────────┘
```

```
src/sim/     motor: TypeScript puro, sem Three.js, determinístico
             world, conveyor, graph/router, fleet, planner, reservations,
             motion, floor, failures, snapshot, state (checkpoints),
             recorder (viagem no tempo, KPIs), export, scenarios,
             policy (heurística de roteamento), routing (divisor), health
             (sinais simulados dos motores e detector)
src/ai/      avaliação pareada, seeds, ambiente de treino, agente (onnxruntime-web),
             professor (heurística em níveis), manutenção preditiva, critério do RL
src/worker/  SimHost (roda a gravação no tempo real), protocolo, visões
             (linha do tempo, histórico) e roteamento (agente sob demanda, cópia
             estática para comparar)
ai/          servidor do motor para o Python, cliente, treino PPO e teste de fidelidade
src/link/    conexão com o worker e buffer de snapshots com interpolação
src/render/  cena Three.js: pacotes, robôs, rastros, rotas, alertas, mapa de calor, bloom,
             halos dos motores, setas de fluxo
src/ui/      HUD e painéis (HTML/CSS próprios)
bench/       benchmark do motor (CI), planejamento, roteamento e manutenção preditiva
tests/       Vitest: motor, frota, planejador, cinemática, falhas, snapshots
```

- **Passo fixo de 1/60 s e determinismo.** Toda aleatoriedade vem de um PRNG
  com seed, dividido em fluxos independentes (pedidos, racks, falhas, frota):
  ligar as falhas automáticas não muda a sequência de pedidos. O ESLint proíbe
  `Math.random`, `Date.now`, `performance.now` e Three.js dentro de `src/sim/`.
- **Simulação no worker.** A página só manda comandos e recebe snapshots: um
  `ArrayBuffer` por quadro, transferido sem cópia e devolvido para reuso. Cada
  snapshot traz a pose atual e a do snapshot anterior de cada pacote e robô; a
  página desenha um intervalo atrás do mais recente e interpola.
- **Esteira = faixa 1D:** cada pacote tem uma posição ao longo da esteira e um
  espaçamento mínimo; as filas surgem sozinhas quando a frente trava.
- **Renderização sem lógica:** a cena só lê snapshots. Pacotes, robôs, alertas
  e marcas estáticas são `InstancedMesh`; todo modelo e toda textura são
  gerados por código.

## Robôs: planejamento multiagente

O piso dos robôs é uma grade de 1 m. Esteiras, racks e pilhas são paredes; os
robôs (baixos) passam por baixo das esteiras só em **8 passagens** marcadas.
Um teste prova que elas são necessárias: sem elas o depósito não alcança a
maioria das docas.

**Cooperative A\* com tabela de reservas no espaço-tempo.** Cada robô planeja
sozinho, um de cada vez, numa busca A* sobre (célula, instante). Ao achar um
caminho, ele reserva cada (célula, instante) numa tabela compartilhada, e o
próximo robô trata essas reservas como obstáculos que se movem. Detalhes que
tornam isso seguro com movimento real:

- **Reservas com folga de 1 passo** (1-robustas): nenhum outro robô usa a mesma
  célula um passo antes ou depois. Isso proíbe troca frente a frente e seguir
  colado, e absorve o atraso de acelerar, frear e fazer curvas.
- **O último destino fica reservado "para sempre"**, até o robô planejar de
  novo. Robô parado é obstáculo; ninguém planeja através dele.
- **O estado da busca inclui direção e paradas:** virar 90° a partir de parado
  exige 1 passo de espera (tempo de girar), dar meia-volta exige 2.
- **Cinemática real:** retas, arcos de 0,5 m nas curvas sem parada, velocidade
  na curva limitada por √(a_lat·r), aceleração e frenagem limitadas, giro no
  lugar nas paradas. O robô nunca passa à frente do plano: a cada tick ele
  escolhe a maior velocidade cuja curva de frenagem fica atrás da referência
  futura.
- **Replanejamento sem tranco:** quem está em movimento se compromete com a
  célula de 2 passos à frente. Se não achar caminho, para nela e a segura; quem
  planejou passar por ali replaneja ("empurrão", que sempre termina).
- **Estações exclusivas com fila** (faces de rack, docas, desvios, carregadores,
  vagas): quem encontra a estação ocupada espera num ponto de fila, fora do
  corredor. Quem falha repetidamente pede a robôs parados no seu caminho que
  saiam da frente.

**Por que Cooperative A\* e não Conflict-Based Search (CBS):** o CBS é ótimo e
completo, mas resolve conflitos numa árvore cujo tamanho cresce de forma
exponencial no pior caso. Aqui o problema é "lifelong": chegam tarefas novas o
tempo todo, e cada replanejamento precisa caber no tempo de um passo da
simulação. O Cooperative A* custa um A* por robô, de custo previsível e
incremental (só replaneja quem mudou). Medido: **cerca de 0,7 ms por plano em média,
1,6–1,7 ms no p95**. O preço é perder a garantia teórica: o CA* pode falhar em
casos em que existe solução. Essa garantia foi trocada por regras (folga,
reserva final, estações com fila, pedido de passagem) e verificada por teste:
6 seeds × 10.000 passos com falhas, mais um turno de 1.000 s, sem colisão e sem
robô travado.

Os robôs têm três funções:

- **Pedidos de estoque:** levam caixas dos racks às docas.
- **Desvio:** cobrem as três esteiras sem rota alternativa (A4→S1, B3→B4,
  B4→S2) enquanto estão quebradas.
- **Bateria:** vão sozinhos ao carregador abaixo de 25%.

## Viagem no tempo

A execução inteira fica gravada no worker, e qualquer instante pode ser
mostrado de novo **exatamente** como foi:

- **Entradas com o tick.** Toda ação que muda a simulação (falha, modo
  automático, teste de carga) é registrada com o tick em que foi aplicada e
  aplicada pela mesma função ao vivo e nos replays. Com o motor
  determinístico, isso basta para refazer qualquer trecho.
- **Checkpoints a cada 30 s simulados.** Um codificador binário próprio grava
  todo o estado que muda (pacotes, esteiras, docas, caminhões, frota, tabela de
  reservas, falhas, métricas) em dois fluxos, de inteiros e de reais com os
  bits exatos. Trajetórias, piso e tabelas de rota são reconstruídos a partir da
  configuração. Média de 122 KB por checkpoint numa hora com falhas.
- **Seek = checkpoint + replay**, num segundo mundo reaproveitado: o mundo ao
  vivo espera, intacto, na ponta da gravação. O replay roda dentro do orçamento
  de 40 ms por bombeamento, então a página vê o "avanço rápido" e pode pedir
  outro instante a qualquer momento.
- **Ramificação.** Continuar a partir do passado, ou injetar uma falha nele,
  transforma aquele mundo no mundo ao vivo e descarta o que vinha depois.
- **Relatório reproduzível.** O JSON exportado (configuração + entradas +
  impressão digital do estado final) roda a execução de novo do zero; ao
  terminar, a página confirma que o estado final bate.

Verificado por teste: restaurado em 48 instantes de execuções caóticas (e no
meio de esperas resolvidas pelo vigia), o mundo continua bit a bit igual ao
original: impressão digital, bytes do snapshot e estatísticas da frota. Onze
campos esquecidos de propósito no checkpoint foram pegos pelos testes.

O mesmo gravador guarda o log de eventos, cada mudança de estado de cada robô e
uma amostra por segundo. É de onde saem o painel de operação (<kbd>K</kbd>), o
histórico ao clicar e a linha do tempo, inclusive para instantes do passado.

## Vigia anti-travamento

O pedido de passagem entre robôs resolve quase tudo, mas pode falhar. Depois
de 6 s sem caminho, um vigia central monta o grafo de quem espera quem (cada
robô espera o primeiro robô parado na sua rota). Num ciclo, testa um recuo para
cada membro, sem efeito colateral, e manda recuar o que sai da frente mais
rápido. Atrás de um robô com defeito, troca a entrega para a outra baia da mesma
doca, se ela puder ser alcançada. Testes montam esses casos de propósito nos 4
portões que são a única entrada das faixas de doca: sem o vigia, dois robôs
frente a frente com os pedidos de passagem falhando ficam parados para sempre;
com ele, os dois passam em no máximo 18,6 s (36 casos). Robô parado há mais de
20 s gera alerta na cena e no log.

## Mapa de calor na GPU

A CPU só envia as posições de pacotes e robôs (que já estão no snapshot). Na
GPU, dois render targets se alternam: um passe decai o campo anterior e outro
soma um splat gaussiano por entidade com mistura aditiva. Os pesos são por
segundo simulado, então o campo não depende do FPS. Uma camada sobre o piso
mapeia o canal escolhido em verde → âmbar → vermelho:

- **ocupação** (memória de 2,5 s);
- **tempo de espera**, ponderado por quanto tempo cada pacote está parado
  (memória de 4 s);
- **tráfego de robôs** (memória de 25 s, para os corredores mais usados
  aparecerem).

## IA de operações

### Roteamento: cinco escolhas, três políticas

Em cinco entroncamentos (A1 e B2 para as docas 1–3 e 4–6, A3 para as docas
1–3), os pacotes têm dois caminhos até as docas de destino. A cada segundo
simulado, uma política decide a **fração** que segue pelo caminho alternativo;
um divisor determinístico (difusão de erro, sem sorteio) cumpre a fração exata.
Três políticas, trocadas ao vivo com <kbd>P</kbd>; o app abre com a heurística,
a política oficial:

- **Estático:** sempre o caminho mais curto (o comportamento das Fases 1 a 3).
- **Heurística:** estima o tempo de cada caminho até onde ele junta com o
  outro (percurso + fila parada em cada esteira; infinito numa esteira quebrada
  que os robôs não cobrem) e move a fração aos poucos em direção à logística da
  diferença. Quando um caminho é cortado, troca na hora. Os dois parâmetros
  foram calibrados nas seeds de validação.
- **IA (PPO):** uma rede neural treinada por reforço decide a fração de cada
  escolha em cinco níveis (0, ¼, ½, ¾, 1). Roda no navegador com
  onnxruntime-web, carregada só quando escolhida.

Setas animadas nos entroncamentos mostram quanto do fluxo segue cada caminho
agora. Ao sair do estático, uma **cópia da simulação** continua com o
roteamento estático e as mesmas entradas (falhas, teste de carga), e o painel
<kbd>K</kbd> mostra as duas lado a lado: ciclo médio, vazão, fila e entregas
desde a troca. As decisões da IA viram entradas gravadas, então a viagem no
tempo e os relatórios reproduzem tudo sem precisar da rede.

A comparação usa 4 cenários de 10 minutos (o primeiro minuto não conta): normal,
esteira com alternativa quebrada, pico de pedidos e falhas automáticas. Só contam
os pacotes que entram pelas esteiras (os pedidos de estoque vão do rack à doca
por robô e não passam por nenhuma escolha), pareados seed a seed, com intervalo
de confiança de 95% (t de Student).

### Conjuntos de seeds

| Conjunto  | Seeds           | Uso                                                                            |
| --------- | --------------- | ------------------------------------------------------------------------------ |
| Treino    | 10.001 a 19.999 | episódios do PPO e demonstrações da imitação                                   |
| Validação | 20.001 a 20.010 | calibração da heurística e do detector; julgamento das rodadas de ajuste da IA |
| Teste     | 30.001 a 30.010 | usadas uma única vez, no resultado final (os benchmarks exigem `--final`)      |

### Treino em Python, no mesmo motor

O ambiente de treino não reimplementa nada em Python: cada ambiente é um
processo Node com o motor TypeScript do app (sem interface), falando um
protocolo binário curto pela entrada e saída padrão (`ai/env-server.ts`). O
Stable-Baselines3 manda as ações para os 16 processos antes de ler qualquer
resposta, então eles simulam em paralelo. Um teste de fidelidade roda o mesmo
episódio pelo servidor e direto no motor e exige a mesma impressão digital do
estado, as mesmas medidas e as mesmas recompensas. As dependências Python ficam
num ambiente virtual próprio (`ai/.venv`), fora do build web e do CI.

A rede só imitada da rodada 2 é **reproduzível bit a bit** entre execuções:
`ai/.venv/Scripts/python ai/check_imitation.py` refaz do zero as 400
demonstrações da heurística e a imitação (cerca de 3 min) e compara o ONNX
gerado, byte a byte, com `ai/models/rodada2-imitacao.onnx` (código de saída 1 se
diferir). Conferido em três execuções independentes, com o mesmo sha256.

<!-- AGENTE -->

### Manutenção preditiva

> **Os sinais são simulados.** Vibração e temperatura vêm de um modelo simples
> (linha de base e resposta à carga de cada motor, desgaste, pancadas, enroscos e
> ruído), não de máquinas reais. Os números medem o detector nesse modelo, não em
> campo, e a escala de tempo é comprimida (minutos em vez de dias).

Três de cada quatro quebras automáticas de esteira vêm depois de 1 a 3 minutos
de desgaste escondido; a quarta é súbita (pense numa falha elétrica). Cada motor
reporta vibração (mm/s) e temperatura (°C) por segundo simulado. O desgaste
aparece com força diferente em cada sinal, às vezes fraca; pancadas (uma caixa
batendo) e enroscos (uma caixa raspando de 5 a 30 s) não têm nada a ver com
desgaste e são o que o detector não pode confundir. O ruído vem de um fluxo
aleatório próprio: o monitoramento nunca muda o fluxo de pacotes (teste).

O detector, por motor:

1. Um filtro de Kalman pequeno aprende quanto aquele motor foge do modelo
   nominal (um desvio e uma inclinação com a carga, para cada sinal) e prevê a
   próxima leitura. Só aprende com leituras a menos de 3 desvios da previsão, e
   devagar depois de assentar, para não absorver o desgaste.
2. z = quanto as duas leituras estão acima do previsto, em desvios, cada uma
   limitada a 4 (uma pancada sozinha não dispara nada).
3. CUSUM: soma acumulada de (z − k), nunca abaixo de 0; o alarme sobe quando
   passa de h. Calibrados nas seeds de validação: **k = 3, h = 48**.

O halo do motor vai de ciano (normal) a âmbar (soma subindo) e vermelho
pulsando (alarme), e o alarme entra no log e na linha do tempo.
<kbd>0</kbd> inicia um desgaste numa esteira para ver o processo inteiro.

**Próximo passo (fora da Fase 4): um CUSUM por sinal.** Com k = 3 e o z de cada
sinal limitado a 4, um sinal sozinho soma no máximo 4/√2 ≈ 2,83 por segundo,
abaixo de k: o desgaste que aparece forte só na vibração ou só na temperatura
nunca acumula, e é a maior parte das quebras com desgaste sem aviso (14 de 62
nas seeds de validação). Dois CUSUMs extras, um por sinal e com limiar próprio,
pegariam parte delas, em troca de mais alarmes falsos com pancadas (só vibram) e
enroscos, e de uma nova calibração.

## Números medidos

Todos os números de cada fase, com método e forma de reproduzir, estão em
[`docs/resultados.md`](docs/resultados.md).

Máquina de desenvolvimento: Chromium com GPU dedicada (RTX 5060 Ti); um
notebook comum fica abaixo, por isso existe o ajuste automático de qualidade.

### Fase 3

| O que                                                                    | Resultado                                                                                                        | Como reproduzir                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Voltar a um instante numa execução de 1 h (40 robôs, falhas automáticas) | mediana 253 ms, p95 484 ms (checkpoint + replay) · replay desde o zero: 65 s (≈255× mais lento)                  | `npm run bench:tempo`            |
| Memória da gravação                                                      | 15,5 MB por hora simulada (14,5 MB de checkpoints, média 122 KB, máximo 172 KB)                                  | `npm run bench:tempo`            |
| Reconstrução                                                             | idêntica bit a bit em 48 instantes de execuções caóticas e no meio de esperas; 11 de 11 campos omitidos pegos    | `tests/checkpoint.test.ts`       |
| 50 viagens no tempo                                                      | GPU: 101 geometrias e 62 texturas antes e depois · heap da simulação estável (+0,03 MB nas 60 viagens seguintes) | Chromium + `npm run bench:tempo` |
| Custo de gravar no motor ao vivo                                         | 4.231 passos/s gravando contra 4.210 sem gravar (dentro do ruído)                                                | `npm run bench`                  |
| Dois robôs frente a frente num portão, pedidos de passagem falhando      | sem vigia: parados para sempre (36 de 36) · com vigia: os dois passam em até 18,6 s                              | `npm run bench:vigia`            |
| Robô quebrado dentro do portão por 60 s                                  | quem tem outra baia espera 7 s (antes 60 s); quem fica preso atrás espera o conserto (60 s)                      | `npm run bench:vigia`            |
| Tentativa de planejamento sem caminho (robô preso)                       | 19–20 ms → 0,002 ms, com resultado idêntico (400 casos comparados)                                               | `tests/planner.test.ts`          |

### Fase 2

| O que                                                                                | Resultado                                                                                                                                         | Como reproduzir                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Segurança da frota (6 seeds × 10.000 passos com falhas + turno de 1.000 s)           | menor distância entre centros de robôs 0,974 m (mínimo seguro 0,89 m), 0 violações de frenagem, atraso máximo em relação ao plano 0,50 s          | `tests/fleet.test.ts`                     |
| Robô travado sem conseguir planejar                                                  | no máximo 15 s (com robôs em defeito e doca bloqueada no meio)                                                                                    | `tests/fleet.test.ts`                     |
| Planejamento (40 robôs, 3 seeds × 10 min)                                            | 0,72–0,74 ms por plano (p95 1,6–1,7 ms), 1,3% de tentativas sem caminho (episódio mais longo: 10 s), rota 7% mais longa que o caminho livre       | `npm run bench:mapf`                      |
| Desvio por robôs (A4→S1 quebrada 3 min, mesma seed com e sem robôs, seeds 2026/7/11) | pico da fila −18% a −21%; entregas até o conserto +44% a +47%                                                                                     | `tests/failures.test.ts`, seção "benefit" |
| Interface com a simulação pesada (16×, teste de carga, salto de 2 min a cada 3 s)    | worker: 0 tarefas longas, pior quadro 16,8 ms, 60 FPS · mesma simulação na thread da página: 8 tarefas longas (4,8 s), pior quadro 250 ms, 47 FPS | Long Tasks API no Chromium, `?sim=main`   |
| Mapa de calor: CPU por quadro                                                        | GPU 0,04–0,07 ms · versão de referência na CPU 0,46–0,67 ms (≈10× menos)                                                                          | `__gemeo.benchHeat()` no console          |
| Desempenho                                                                           | 2.369 pacotes desenhados + 40 robôs a 60 FPS em qualidade alta, com bloom                                                                         | teste de carga (<kbd>T</kbd>)             |
| Motor no Node (mediana de 5)                                                         | 4.086 passos/s com 40 robôs (≈68× o tempo real); 941 mil passos/s sem robôs                                                                       | `npm run bench`                           |
| 5 reinícios seguidos                                                                 | geometrias e texturas na GPU estáveis (sem vazamento)                                                                                             | `Shift+R`                                 |

### Fase 1

| Cenário                                        | Resultado                                                |
| ---------------------------------------------- | -------------------------------------------------------- |
| Regime normal (3,6 pedidos/s), 6 min simulados | 212 pacotes/min, tempo médio no sistema 31,6 s, fila ≈ 5 |
| Mesmo teste de carga com a CPU limitada a 4×   | cai para qualidade média sozinho e volta a 60 FPS        |

## Achados que mudaram o código

Bugs encontrados medindo, não supondo:

- **Estação "livre" com robô em cima.** A posse da estação era liberada quando o
  robô terminava a tarefa, mas ele só sai da célula no passo seguinte. Outros
  robôs eram mandados para lá e falhavam ao planejar. Com a correção, as
  tentativas sem caminho caíram de 31% para 1,3%, e o tempo por plano de 6,96 ms
  para 0,72 ms.
- **Frenagem brusca ao replanejar.** Mudar o plano na célula seguinte mudava o
  formato da curva com o robô já chegando. Comprometer 2 passos à frente zerou
  as violações de frenagem.
- **Dois robôs reservando a mesma parada.** Um robô que precisava parar podia
  encontrar a célula reservada "para sempre" por outro que ainda estava a
  caminho dela. Esse outro agora também replaneja.
- **Pedido de passagem mútuo e inútil** (Fase 3). Dois robôs que se
  bloqueavam pediam passagem um ao outro na mesma rodada, e os dois recuavam.
  Um robô atrás de outro quebrado pedia passagem a todos na rota, mandando
  robôs para trás à toa. Agora só um recua, e ninguém é chamado quando a rota
  está fechada por quem não pode se mover.
- **Cada tentativa sem caminho esgotava 60 mil estados** (Fase 3). Uma prova
  barata (busca em largura com os robôs parados como parede) responde "não há
  caminho" sem buscar no espaço-tempo; um teste compara as duas respostas em
  400 casos aleatórios, com zero diferenças.
- **Último bit diferente depois de restaurar** (Fase 3). As métricas
  recalculavam a soma da janela ao compactar a memória, e a soma em ponto
  flutuante dependia de quando isso acontecia. O mundo restaurado compactava em
  outro momento e divergia no último bit. A compactação deixou de recalcular.
- **Gargalo estrutural e pontos únicos de falha** (Fase 1): com roteamento
  estático, a esteira E9 opera a ~81%; A4→S1, B3→B4 e B4→S2 não têm
  alternativa por esteira. Os robôs cobrem essas três; o rebalanceamento é
  tarefa da IA (Fase 4).
- **O treino passava 75% do tempo num ajudante do compilador** (Fase 4). O
  `tsx` compila com `keepNames`, que embrulha cada função criada em tempo de
  execução para guardar o nome; o código de movimento cria funções pequenas nos
  laços internos. Um episódio de 10 minutos levava 11 s; compilado com esbuild
  sem essa opção (como o Vite já faz no app), 1,9 s, com resultado idêntico.
- **Detector de manutenção com 20% a 69% de precisão** (Fase 4). Um modelo fixo
  do motor errava o viés de cada motor e a resposta à carga; um filtro de
  Kalman por motor passou a aprender o "normal" de cada um. Depois, todos os 29
  alarmes falsos restantes (com k = 1 e h = 8, antes de calibrar) aconteciam de 2
  a 16 s depois de um reparo: o motor que quebrou gasto volta quente (memória
  térmica). O gêmeo passou a ressincronizar a temperatura quando o motor religa.
- **Bom demais para ser verdade** (Fase 4). Com o desgaste sempre forte e sem
  distúrbios, o detector acertava 100%. Entraram quebras súbitas, desgaste
  fraco, pancadas e enroscos, e a calibração passou a ter um compromisso real
  (ótimo no meio da grade, não na borda).
- **Conferência por mutação parada para sempre** (Fase 4). Um mutante
  transformou um "espere um desgaste começar" num laço infinito, e o Vitest não
  interrompe código síncrono. O teste ganhou limite e o executor de mutação
  passou a encerrar a rodada que passa de 5× o tempo da linha de base (conta
  como pega).

## Limitações honestas

- É uma simulação simplificada para portfólio, não um sistema de produção:
  tempos de serviço fixos, pacotes sem peso nem volume reais, caminhões de
  capacidade fixa e sem horário.
- O Cooperative A* não tem garantia teórica de completude; a ausência de
  colisão e de travamento foi verificada por testes com várias seeds, não
  provada.
- Os robôs carregam 6 caixas por viagem. O desvio alivia a fila, mas não
  substitui a esteira (cerca de 0,45 pacote/s contra 1,8 pacote/s da esteira).
- **Os sinais de manutenção são simulados**, de um modelo simples; os números
  medem o detector nesse modelo, não em máquinas reais. O detector precisa que o
  desgaste apareça nos dois sinais: desgaste forte num sinal só, em geral rápido
  (60 a 100 s), passa despercebido (14 das 62 quebras com desgaste nas seeds de
  validação). Quebras súbitas não têm aviso por definição.
- A cópia estática do painel recebe as mesmas entradas, mas as falhas
  automáticas são sorteadas de novo nela (mesma semente): os alvos podem
  divergir quando os dois mundos ficam diferentes.
- Os FPS foram medidos numa GPU dedicada. A contagem de tarefas longas usa uma
  API que só existe no Chromium.
- A gravação vive na memória do worker (cerca de 15 MB por hora simulada) e se
  perde ao recarregar a página; para guardar uma execução, exporte o relatório.
- Só existe uma linha do tempo: continuar a partir do passado descarta o que
  vinha depois (não há árvore de ramificações).
- Depois de um salto no tempo, a cor de "pacote esperando" recomeça do zero: o
  tempo de espera de cada pacote é acompanhado por quem desenha, não guardado no
  checkpoint.
- O vigia resolve esperas circulares e desvia de robôs quebrados quando há outra
  baia; um robô preso atrás de um robô quebrado, sem outro caminho, espera o
  conserto (40 a 60 s).

## Créditos

Fontes Barlow Condensed e JetBrains Mono (SIL Open Font License), empacotadas
via `@fontsource`. Sem nenhum outro asset externo.

## Licença

[MIT](LICENSE) © 2026 João Pedro Ferreira.
