# Gêmeo Digital de Centro de Distribuição

[![CI](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/ci.yml/badge.svg)](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/ci.yml)
[![Deploy](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/deploy.yml/badge.svg)](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/deploy.yml)

**Demo:** https://joaoferreira32.github.io/gemeo-digital-cd/

Simulação 3D em tempo real, no navegador, de um galpão logístico: esteiras,
pacotes, docas, caminhões e uma frota de 40 robôs (AGVs) que se coordenam por
planejamento multiagente, com falhas injetadas e mapa de calor. O motor de
simulação é determinístico, roda num Web Worker e é testado sem navegador.

> **Status:** Fase 2 de 6 concluída (frota de robôs e caos controlado). Viagem
> no tempo, IA de operações, laboratório de cenários e modo cinema vêm depois.

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
```

`?sim=main` na URL roda a simulação na thread da página em vez do worker
(usado para comparar).

## Controles

| Ação                   | Mouse / teclado                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| Girar                  | arrastar · <kbd>Q</kbd> <kbd>E</kbd>                                                                    |
| Mover                  | botão direito ou <kbd>Shift</kbd> + arrastar · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / setas |
| Zoom                   | roda do mouse (em direção ao cursor) · <kbd>+</kbd> <kbd>−</kbd>                                        |
| Inclinar               | <kbd>R</kbd> <kbd>F</kbd>                                                                               |
| Câmeras                | <kbd>1</kbd> aérea · <kbd>2</kbd> chão · <kbd>3</kbd> seguir robô · <kbd>N</kbd> próximo robô           |
| Pausar / velocidade    | <kbd>Espaço</kbd> · <kbd>,</kbd> <kbd>.</kbd> (1×, 4×, 16×)                                             |
| Falhas                 | <kbd>5</kbd> esteira · <kbd>6</kbd> pico de pedidos · <kbd>7</kbd> robô · <kbd>8</kbd> doca             |
| Falhas automáticas     | <kbd>9</kbd>                                                                                            |
| Mapa de calor          | <kbd>M</kbd> ocupação → tempo de espera → tráfego de robôs → desligado                                  |
| Teste de carga         | <kbd>T</kbd> (taxa de pedidos muito acima da capacidade)                                                |
| Qualidade gráfica      | <kbd>G</kbd> (desliga o ajuste automático)                                                              |
| Reiniciar (mesma seed) | <kbd>Shift</kbd> + <kbd>R</kbd>                                                                         |
| Atalhos e legenda      | <kbd>H</kbd>                                                                                            |

## Arquitetura

```
 página (thread principal)                         Web Worker
 ┌──────────────────────────────┐   comandos    ┌───────────────────────────┐
 │ ui/      HUD, controles      │ ────────────► │ worker/  SimHost: relógio │
 │ link/    FrameBuffer:        │               │          real × velocidade│
 │          interpola snapshots │ ◄──────────── │ sim/     World (passo     │
 │ render/  Three.js (só lê)    │  snapshot em  │          fixo, seed)      │
 └──────────────────────────────┘  ArrayBuffer  └───────────────────────────┘
                                   transferido
```

```
src/sim/     motor: TypeScript puro, sem Three.js, determinístico
             world, conveyor, graph/router, fleet, planner, reservations,
             motion, floor, failures, snapshot
src/worker/  SimHost (roda o World no tempo real) e o protocolo de mensagens
src/link/    conexão com o worker e buffer de snapshots com interpolação
src/render/  cena Three.js: pacotes, robôs, rastros, rotas, alertas, mapa de calor, bloom
src/ui/      HUD e painéis (HTML/CSS próprios)
bench/       benchmark do motor (CI) e estatísticas do planejamento
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
incremental (só replaneja quem mudou). Medido: **0,72 ms por plano em média,
1,62 ms no p95**. O preço é perder a garantia teórica: o CA* pode falhar em
casos em que existe solução. Essa garantia foi trocada por regras (folga,
reserva final, estações com fila, pedido de passagem) e verificada por teste:
6 seeds × 10.000 passos com falhas, mais um turno de 1.000 s, sem colisão e sem
robô travado.

Os robôs têm três funções:

- **Pedidos de estoque:** levam caixas dos racks às docas.
- **Desvio:** cobrem as três esteiras sem rota alternativa (A4→S1, B3→B4,
  B4→S2) enquanto estão quebradas.
- **Bateria:** vão sozinhos ao carregador abaixo de 25%.

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

## Números medidos

Máquina de desenvolvimento: Chromium com GPU dedicada (RTX 5060 Ti); um
notebook comum fica abaixo, por isso existe o ajuste automático de qualidade.

### Fase 2

| O que                                                                                | Resultado                                                                                                                                         | Como reproduzir                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Segurança da frota (6 seeds × 10.000 passos com falhas + turno de 1.000 s)           | menor distância entre centros de robôs 0,974 m (mínimo seguro 0,89 m), 0 violações de frenagem, atraso máximo em relação ao plano 0,50 s          | `tests/fleet.test.ts`                     |
| Robô travado sem conseguir planejar                                                  | no máximo 15 s (com robôs em defeito e doca bloqueada no meio)                                                                                    | `tests/fleet.test.ts`                     |
| Planejamento (40 robôs, 3 seeds × 10 min)                                            | 0,72 ms por plano (p95 1,62 ms), 1,3% de tentativas sem caminho, rota 7% mais longa que o caminho livre                                           | `npm run bench:mapf`                      |
| Desvio por robôs (A4→S1 quebrada 3 min, mesma seed com e sem robôs, seeds 2026/7/11) | pico da fila −18% a −21%; entregas até o conserto +44% a +47%                                                                                     | `tests/failures.test.ts`, seção "benefit" |
| Interface com a simulação pesada (16×, teste de carga, salto de 2 min a cada 3 s)    | worker: 0 tarefas longas, pior quadro 16,8 ms, 60 FPS · mesma simulação na thread da página: 8 tarefas longas (4,8 s), pior quadro 250 ms, 47 FPS | Long Tasks API no Chromium, `?sim=main`   |
| Mapa de calor: CPU por quadro                                                        | GPU 0,04–0,07 ms · versão de referência na CPU 0,46–0,67 ms (≈10× menos)                                                                          | `__gemeo.benchHeat()` no console          |
| Desempenho                                                                           | 2.369 pacotes desenhados + 40 robôs a 60 FPS em qualidade alta, com bloom                                                                         | teste de carga (<kbd>T</kbd>)             |
| Motor no Node (mediana de 5)                                                         | 3.513 passos/s com 40 robôs (≈58× o tempo real); 950 mil passos/s sem robôs                                                                       | `npm run bench`                           |
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
- **Gargalo estrutural e pontos únicos de falha** (Fase 1): com roteamento
  estático, a esteira E9 opera a ~81%; A4→S1, B3→B4 e B4→S2 não têm
  alternativa por esteira. Os robôs cobrem essas três; o rebalanceamento é
  tarefa da IA (Fase 4).

## Limitações honestas

- É uma simulação simplificada para portfólio, não um sistema de produção:
  tempos de serviço fixos, pacotes sem peso nem volume reais, caminhões de
  capacidade fixa e sem horário.
- O Cooperative A* não tem garantia teórica de completude; a ausência de
  colisão e de travamento foi verificada por testes com várias seeds, não
  provada.
- Os robôs carregam 6 caixas por viagem. O desvio alivia a fila, mas não
  substitui a esteira (cerca de 0,45 pacote/s contra 1,8 pacote/s da esteira).
- Esteiras quebradas que têm alternativa não são contornadas ainda: o
  roteamento dos pacotes é estático até a IA da Fase 4.
- Os FPS foram medidos numa GPU dedicada. A contagem de tarefas longas usa uma
  API que só existe no Chromium.

## Créditos

Fontes Barlow Condensed e JetBrains Mono (SIL Open Font License), empacotadas
via `@fontsource`. Sem nenhum outro asset externo.

## Licença

[MIT](LICENSE) © 2026 João Pedro Ferreira.
