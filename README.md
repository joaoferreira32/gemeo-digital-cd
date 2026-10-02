# Gêmeo Digital de Centro de Distribuição

[![CI](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/ci.yml/badge.svg)](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/ci.yml)
[![Deploy](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/deploy.yml/badge.svg)](https://github.com/joaoferreira32/gemeo-digital-cd/actions/workflows/deploy.yml)

**Demo:** https://joaoferreira32.github.io/gemeo-digital-cd/

Simulação 3D em tempo real, no navegador, de um galpão logístico: esteiras,
pacotes, docas e caminhões, com um motor de simulação determinístico separado
da renderização.

> **Status:** Fase 1 de 4 concluída (galpão 3D e fluxo básico). Robôs (AGVs),
> falhas, mapa de calor, IA de otimização e o modo vídeo vêm nas próximas fases.

## Como rodar

Requer Node.js 20+ (desenvolvido com o 24 LTS).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # testes do motor (Vitest)
npm run lint       # ESLint + Prettier
npm run build      # build estático em dist/
```

## Controles

| Ação                   | Mouse / teclado                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| Girar                  | arrastar · <kbd>Q</kbd> <kbd>E</kbd>                                                                    |
| Mover                  | botão direito ou <kbd>Shift</kbd> + arrastar · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / setas |
| Zoom                   | roda do mouse (em direção ao cursor) · <kbd>+</kbd> <kbd>−</kbd>                                        |
| Inclinar               | <kbd>R</kbd> <kbd>F</kbd>                                                                               |
| Câmeras                | <kbd>1</kbd> aérea · <kbd>2</kbd> chão · <kbd>3</kbd> seguir pacote                                     |
| Pausar                 | <kbd>Espaço</kbd>                                                                                       |
| Teste de carga         | <kbd>T</kbd> (taxa de pedidos muito acima da capacidade)                                                |
| Qualidade gráfica      | <kbd>G</kbd> (desliga o ajuste automático)                                                              |
| Reiniciar (mesma seed) | <kbd>Shift</kbd> + <kbd>R</kbd>                                                                         |
| Atalhos e legenda      | <kbd>H</kbd>                                                                                            |

## Arquitetura

```
src/sim/     motor de simulação: TypeScript puro, sem Three.js, determinístico
src/ai/      (fase 3) otimizador de rotas
src/render/  cena Three.js: só LÊ o estado da simulação
src/ui/      HUD e controles (HTML/CSS próprios)
tests/       testes do motor, das métricas e do controle de qualidade
```

- **Passo fixo** de 1/60 s. O laço de animação acumula o tempo real e chama
  `world.step()` quantas vezes for preciso; a renderização interpola a posição
  dos pacotes entre os dois últimos passos.
- **Determinismo:** toda aleatoriedade vem de um PRNG com seed (mulberry32),
  dividido em fluxos independentes (`deriveSeed(seed, 'orders')`). Mudar a
  velocidade das esteiras não muda a sequência de pedidos — base para comparar
  cenários A/B com a mesma demanda. O ESLint proíbe `Math.random`, `Date.now`,
  `performance.now` e imports de Three.js dentro de `src/sim/`.
- **Esteira = faixa 1D:** cada pacote tem uma posição `s` ao longo da esteira e
  um espaçamento mínimo. A vazão máxima é velocidade ÷ espaçamento, e as filas
  surgem sozinhas quando a frente trava — não existe um "contador de fila".
- **Roteamento atrás de uma interface (`Router`):** hoje, caminho mínimo
  estático; a IA da fase 3 entra no lugar sem mexer no motor.
- **Renderização:** todos os pacotes (esteiras, pilha de entrada e área de
  expedição) são instâncias de um único `InstancedMesh`, com as matrizes
  escritas direto no `Float32Array`. Todo modelo 3D e toda textura são gerados
  por código.

## Números medidos (Fase 1)

Medidos com Chromium + GPU dedicada (RTX 5060 Ti); um notebook comum deve
ficar abaixo, por isso existe o ajuste automático de qualidade.

| Cenário                                        | Resultado                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Regime normal (3,6 pedidos/s), 6 min simulados | 212 pacotes/min, tempo médio no sistema 31,6 s, fila ≈ 5                           |
| Teste de carga, 2.288 pacotes desenhados       | 60 FPS em qualidade alta                                                           |
| Mesmo teste com a CPU limitada a 4×            | cai para qualidade média sozinho e volta a 60 FPS                                  |
| Custo por quadro (teste de carga)              | simulação 0,002 ms/passo · pacotes 0,19 ms · render 3,1 ms (alta) / 1,1 ms (média) |
| 5 reinícios seguidos                           | geometrias e texturas na GPU constantes (sem vazamento)                            |

## Decisões e achados até aqui

- **Gargalo estrutural:** com roteamento estático, a esteira E9 (B3→B4)
  recebe o fluxo das duas linhas e opera a ~81% da capacidade, enquanto duas
  transversais ficam ociosas. É de propósito o ponto que a IA da fase 3 vai
  balancear.
- **Pontos únicos de falha:** A4→S1, B3→B4 e B4→S2 não têm rota alternativa
  por esteira (travado em teste). Os AGVs da fase 2 serão o desvio.
- **Recuperação de fila é lenta, e isso é correto:** depois de 2 min com a
  esteira da doca 3 parada, a fila leva minutos para escoar, porque o limite é
  a folga da esteira mais carregada (teoria de filas), não a doca.

## Limitações honestas

É uma simulação simplificada para portfólio, não um sistema de produção:
tempos de serviço fixos, pacotes sem peso/volume reais, caminhões de
capacidade fixa e sem horário.

## Créditos

Fontes Barlow Condensed e JetBrains Mono (SIL Open Font License), empacotadas
via `@fontsource`. Sem nenhum outro asset externo.

## Licença

[MIT](LICENSE) © 2026 João Pedro Ferreira.
