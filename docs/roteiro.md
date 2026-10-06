# Roteiro do projeto

O roteiro combinado no começo do projeto, para conferir cada plano de fase
contra ele. O texto das seções abaixo é o dos pedidos originais, sem edição; o
que mudou depois, com aprovação, fica em "Mudanças aprovadas depois".

Vieram de dois pedidos, os dois de 2026-10-02. O primeiro descreveu o projeto, a
Fase 1 e uma primeira versão das fases seguintes. Depois da Fase 1, o segundo
mudou a regra das fases e redefiniu as fases 2 a 6. Valem a Fase 1 do primeiro
pedido e as fases 2 a 6 do segundo; a primeira versão das fases 2 a 4 fica no
apêndice, só como registro.

## O projeto

Você vai construir o "Gêmeo Digital de Centro de Distribuição": uma simulação 3D em tempo real, rodando no navegador, de um galpão logístico com esteiras, pacotes, robôs autônomos (AGVs), docas e falhas, com uma IA de otimização que detecta gargalos e reroteia o fluxo. O objetivo é um projeto de portfólio com visual impressionante E engenharia real por trás, para gravar um vídeo de demonstração sem narração.

## Regras de trabalho

- Trabalhe em fases. Ao fim de cada fase: rode os testes, rode o app, resuma o que foi feito e PARE para eu revisar antes de seguir.
- Antes de codar, me mostre o plano de pastas e as decisões de arquitetura em poucas linhas.
- Código e comentários em inglês, textos da interface e README em português do Brasil.
- Nada de dados pessoais, chaves ou assets com direitos autorais. Todos os modelos 3D devem ser gerados por código (caixas, cilindros, geometrias simples) para o projeto ser 100% autocontido.
- Commits pequenos e com mensagens claras (Conventional Commits).

Depois da Fase 1, a regra das fases mudou:

> Depois, vamos elevar o projeto ao nível master. A regra muda: cada fase precisa ter (a) um efeito visual marcante, (b) engenharia real e testável por trás e (c) um número medido que prove o ganho. Continue parando ao fim de cada fase para eu revisar. Antes de cada fase, me mostre o plano em até 15 linhas.

## Stack

- Vite + TypeScript + Three.js (sem frameworks de UI; HTML/CSS próprios).
- Vitest para testes. ESLint + Prettier.
- GitHub Actions para CI (lint + testes + build).
- Deploy estático (GitHub Pages ou Netlify), sem backend nesta versão.

## Arquitetura (importante)

Separe SIMULAÇÃO de RENDERIZAÇÃO:

- `src/sim/`: motor de simulação em TypeScript puro, sem Three.js, determinístico (PRNG com seed), com passo de tempo fixo. Contém: layout do galpão (grafo de nós e arestas), esteiras (capacidade, velocidade, estado ok/quebrada), pacotes (id, origem, destino, instante de criação), robôs AGV (posição, rota, carga, bateria opcional), docas de saída, filas, gerador de pedidos (taxa configurável + picos), injetor de falhas.
- `src/ai/`: otimizador de rotas e balanceamento.
- `src/render/`: cena Three.js que apenas LÊ o estado da simulação e desenha.
- `src/ui/`: painel de controle, HUD de métricas, legendas.
- `tests/`: testes da simulação e da IA.

Isso permite testar a lógica sem navegador e comparar cenários com números reais.

## Fase 1: galpão 3D e fluxo básico

- Cena com iluminação estilo galpão industrial moderno, piso com reflexo sutil, paleta escura com realces nítidos (defina 4-6 cores e uma tipografia distinta, sem visual genérico de dashboard).
- Esteiras com pacotes fluindo da entrada até as docas. Instanciamento (InstancedMesh) para aguentar milhares de pacotes a 60 FPS.
- Câmera orbital própria com zoom, giro e pan suaves (mouse + teclado), mais câmeras pré-definidas (visão aérea, ao nível do chão, seguir robô) trocáveis por atalho.
- HUD com FPS, pacotes na fila, pacotes entregues, tempo médio no sistema.

Critério de pronto: galpão funcionando e bonito, pacotes fluindo, testes do motor básico passando.

## Fase 2: frota de robôs e caos controlado

- Mova o motor de simulação para um Web Worker. A renderização recebe snapshots por mensagem (com interpolação entre passos para movimento suave). A interface nunca pode travar por causa da simulação.
- AGVs com cinemática simples (aceleração, frenagem, raio de giro) e bateria: descarregam com o uso e vão sozinhos para estações de recarga quando ficam abaixo de um limiar.
- Planejamento multiagente de rotas com reserva no espaço-tempo (tabela de reservas de nó e aresta por instante). Implemente Cooperative A* e documente por que escolheu isso em vez de Conflict-Based Search. Testes: nenhuma colisão, nenhum deadlock em 10.000 passos com 40 robôs e seeds variadas.
- Os robôs servem de desvio para os trechos sem rota alternativa (A4→S1, B3→B4, B4→S2).
- Falhas: esteira quebrada, pico de pedidos, robô com defeito, doca bloqueada. Botão, atalho e modo automático.
- Mapa de calor em shader (não textura recalculada na CPU), com camadas trocáveis: ocupação, tempo de espera e tráfego de robôs.
- Visual: bloom, rastro de luz nos robôs, sombra suave, linhas holográficas mostrando a rota planejada de cada robô (aparecendo quando a câmera se aproxima). Tudo com respeito a prefers-reduced-motion e ao nível de qualidade.
- Modo "seguir" passa a seguir um robô, com painel mostrando bateria, carga, rota e estado.

## Fase 3: viagem no tempo e observabilidade

- Registre todos os eventos da simulação (event sourcing). Linha do tempo na parte de baixo: o usuário arrasta e volta a qualquer instante, e pode reproduzir a partir dali. Reconstrua o estado por checkpoints + eventos.
- Painel de KPIs ao estilo de centro de operações: vazão, tempo de ciclo médio e p95, utilização por recurso, robôs ativos/carregando/parados, gráfico ao vivo dos últimos 5 minutos.
- Clique em qualquer esteira, doca ou robô para ver o histórico dele.
- Exportação do log de eventos em CSV e de um relatório de execução em JSON.

## Fase 4: IA de operações

- Detector de gargalo com explicação em texto, baseado em utilização e crescimento de fila em janela móvel.
- Otimizador heurístico (custos dinâmicos de aresta, balanceamento entre docas, redistribuição de robôs) como linha de base.
- Otimizador por aprendizado por reforço: crie uma pasta `training/` em Python, com um ambiente Gymnasium que reproduz o mesmo motor (ou que chama o motor em TypeScript via um modo headless em Node, o que for mais fiel; justifique a escolha). Treine uma política simples (PPO com Stable-Baselines3), exporte para ONNX e rode no navegador com onnxruntime-web. Se o RL não superar a heurística, mostre isso honestamente no README: o resultado negativo também é resultado.
- Manutenção preditiva: esteiras acumulam desgaste e emitem sinais (vibração/temperatura simuladas). Um modelo simples prevê a falha antes de acontecer, e a IA programa a manutenção num horário de baixa demanda. Mostre "falha evitada" na tela.
- Seletor no painel: sem IA, heurística, RL. A troca é ao vivo.

## Fase 5: laboratório de cenários com estatística

- Modo "e se...?": o usuário altera parâmetros (robôs, esteiras, taxa de pedidos, política de IA) e o sistema roda N seeds em paralelo (vários Web Workers) para o cenário A e o cenário B.
- Resultado com média e intervalo de confiança de 95% para tempo de ciclo, p95 de espera, vazão e utilização. Gráfico de comparação lado a lado.
- Calibração com dados reais: use a distribuição horária e semanal de pedidos do dataset público Olist (Kaggle) para gerar a demanda. Deixe um script que processa o CSV e gera um JSON pequeno de perfil de demanda, para o app não depender do dataset completo. Documente a fonte.
- Tabela de benchmarks no README gerada automaticamente por um comando (`npm run bench`).

## Fase 6: modo cinema e entrega final

- Diretor de câmera: modo apresentação com movimentos de câmera cinematográficos (travelling, aproximação no ponto de falha, profundidade de campo leve), legendas de eventos na tela e números grandes no final. Como o vídeo é mudo, as legendas contam a história.
- Botão "Rodar demo": roteiro determinístico de ~60 segundos — plano aberto, robôs em movimento, falha na esteira, fila vermelha no mapa de calor, IA detecta e explica o gargalo, reroteamento, manutenção preditiva evitando uma segunda falha, volta no tempo para comparar, resultado final com o ganho medido.
- Gravação nativa: botão para gravar a demo direto em vídeo pelo navegador (MediaRecorder sobre o canvas), em 1080p e 60 FPS, sem depender de programa externo.
- README final: GIF no topo, diagrama de arquitetura, decisões técnicas e trade-offs, tabela de benchmarks com intervalos de confiança, limitações honestas (simulação simplificada, não um sistema de produção) e próximos passos.

## Qualidade em todas as fases

- Teste antes de afirmar. Todo número exibido ou citado no README vem do motor ou de benchmark reproduzível.
- 60 FPS com 2.000 pacotes e 40 robôs na máquina atual; degradação automática de qualidade em máquinas mais fracas.
- Sem vazamento de memória ao reiniciar ou ao viajar no tempo.
- CI cobrindo lint, testes, build e um benchmark curto que falha se o desempenho regredir mais de 15%.
- Commits pequenos, com mensagens claras.

## Mudanças aprovadas depois

O registro começa em 2026-10-06, montado a partir do histórico das conversas.
Das fases 1 a 3 só estão aqui as mudanças que ficaram registradas; o que foi
feito em cada fase está no README e em `docs/resultados.md`.

- **2026-10-02, CI.** O benchmark do CI bloqueia regressões acima de 10% nos
  casos de passos/s, com uma rodada de confirmação, e só avisa no tempo do
  snapshot (o roteiro dizia 15%). Decidido depois de medir a variação real
  entre rodadas.
- **2026-10-02, proteção da `main`.** Merge só com todas as verificações
  passando (lint, testes, build e benchmark) e o branch atualizado.
- **2026-10-02, Fase 3.** Acréscimo: o vigia anti-travamento, com um teste
  determinístico que monta de propósito dois robôs esperando um pelo outro com
  os pedidos de passagem falhando (o vigia resolve em tempo limitado), e o mesmo
  para um robô com defeito em corredor estreito, medindo e mostrando a espera
  máxima.
- **2026-10-03, Fase 4.** Plano aprovado com ajustes: três conjuntos de seeds
  (treino, validação e teste, este usado uma única vez); critério do RL contra a
  heurística (p95 melhor em pelo menos 7 de 10 seeds, ganho médio de pelo menos
  3% com IC 95% acima de zero, sem perder vazão, sem piorar de forma
  significativa o p95 de nenhum cenário nem o p99 ou a espera máxima); até 3
  rodadas de no máximo 2 milhões de decisões; dependências Python em `ai/.venv`.
  A pasta do treino ficou `ai/` em vez de `training/`.
- **2026-10-03, Fase 4 (lacuna).** O plano aprovado deixou de fora, sem dizer,
  três itens do roteiro: o detector de gargalo com explicação em texto; a
  manutenção programada num horário de baixa demanda, com "falha evitada" na
  tela; e o balanceamento entre docas e a redistribuição de robôs na heurística.
  Achado em 2026-10-06, conferindo o plano contra este roteiro.
- **2026-10-06, Fase 4b.** Aprovada, num PR próprio, com os dois primeiros
  itens da lacuna, e com a medida de quantas quebras foram evitadas nas seeds de
  validação e de teste. O terceiro entra nas limitações do README como não
  feito.
- **2026-10-06, ordem até o fim.** Fase 4b, depois Fase 5, depois Fase 6. O
  vídeo só é gravado com o projeto inteiro pronto.
- **2026-10-06, Fase 5.** Plano aprovado com um ajuste: o atalho do laboratório
  não pode ser a tecla L (já é "voltar ao vivo" da linha do tempo), e todos os
  atalhos são conferidos para não haver conflito. A licença do dataset da Olist
  é confirmada pelo usuário antes de a fase começar.

## Apêndice: a primeira versão das fases 2 a 4

Do primeiro pedido. Substituída depois da Fase 1 pelas fases 2 a 6 acima; vários
itens dela voltaram nas fases novas. Só os níveis dos títulos mudaram.

### Fase 2: robôs, filas, falhas e mapa de calor

- AGVs que transportam pacotes entre zonas, com caminho calculado (A*) sobre o grafo e desvio de outros robôs (reserva de nós/arestas ou regra de prioridade simples, sem deadlock).
- Filas visíveis diante de cada gargalo; capacidade limitada por esteira e por doca.
- Falhas: esteira quebra (para por N segundos), pico de pedidos, robô com defeito. Cada uma acionada por botão e por atalho de teclado, e também aleatória em modo automático.
- Mapa de calor sobre o piso (textura atualizada em tempo real) mostrando ocupação e filas, com transição de verde para vermelho.
- Efeitos: brilho (bloom), rastros de luz nos robôs, partículas leves em eventos, alerta pulsante no ponto de falha. Tudo com intensidade controlável e respeitando prefers-reduced-motion.

Critério de pronto: dá para quebrar uma esteira e ver a fila vermelha crescer, sem travar o sistema.

### Fase 3: IA de otimização e cenários "e se...?"

- Detector de gargalo: calcula por nó/aresta a utilização e o tamanho médio de fila em janela móvel, e aponta o pior ponto com explicação em texto ("Esteira 3 com 94% de ocupação; fila crescendo há 12s").
- Reroteamento: ao detectar gargalo ou falha, o otimizador redistribui pacotes e robôs por rotas alternativas (custo dinâmico por aresta, balanceamento de carga entre docas). Implemente primeiro com regras + A* com pesos dinâmicos. Deixe a interface do otimizador abstrata (`Optimizer`) para eu poder trocar depois por outro método (ex.: aprendizado por reforço).
- Modo "e se...?": o usuário muda parâmetros (mais N robôs, mais uma esteira, taxa de pedidos maior) e o sistema roda a MESMA simulação (mesma seed) em alta velocidade para o cenário A e o cenário B, mostrando comparação lado a lado de: tempo médio de ciclo, p95 do tempo de espera, vazão (pacotes/min), utilização por recurso.
- Controle de tempo: pausar, 1x, 4x, 16x e "avanço rápido até o resultado".

Critério de pronto: o benchmark mostra números reais de melhoria (ex.: "reroteamento reduziu o tempo médio de fila em X%") e isso é reproduzível pela seed.

### Fase 4: modo vídeo e entrega profissional

- Modo apresentação: esconde menus, mostra apenas HUD limpo e legendas de eventos na tela ("Esteira 3 quebrou", "IA reroteando 38 pacotes", "Fila reduziu 62%"). Como o vídeo será mudo, as legendas substituem a narração.
- Roteiro automático de demonstração (botão "Rodar demo"): executa em ~45 segundos a sequência: plano aberto, giro de câmera, falha na esteira, fila vermelha, IA reroteando, recuperação, comparação antes/depois com números grandes no final. Deve ser determinístico para eu gravar quantas vezes precisar com o OBS.
- Polimento: tela de carregamento rápida, responsivo, foco visível no teclado, alto contraste legível, favicon.
- README de portfólio em português: o que é, GIF/vídeo, arquitetura (diagrama), como rodar, decisões técnicas, tabela de resultados dos benchmarks, limitações honestas (é uma simulação simplificada, não um sistema de produção) e próximos passos.
- Cobertura de testes na simulação e na IA (determinismo por seed, conservação de pacotes, ausência de deadlock, otimizador melhora a métrica no cenário de falha).

### Qualidade mínima

- 60 FPS com pelo menos 2.000 pacotes visíveis em um notebook comum; se cair, reduza efeitos automaticamente e mostre o nível de qualidade no HUD.
- Sem vazamento de memória (descarte geometrias e materiais ao reiniciar).
- Todos os números exibidos na interface vêm do motor de simulação, nunca inventados no front.
