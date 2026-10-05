import type { SimEventKind } from './failures';
import type { RobotStage } from './fleet';

/** Viewer-facing names (pt-BR), shared by the panels and the exported logs. */
export const STAGE_LABEL: Record<RobotStage, string> = {
  parked: 'Estacionado',
  toPark: 'Voltando à vaga',
  toPickup: 'Indo buscar caixas',
  loading: 'Carregando caixas',
  toDrop: 'Indo entregar',
  unloading: 'Descarregando',
  toCharger: 'Indo recarregar',
  charging: 'Recarregando',
  defect: 'Com defeito',
  toPoint: 'Em deslocamento',
};

export const EVENT_LABEL: Record<SimEventKind, string> = {
  'failure-start': 'Falha',
  'failure-end': 'Fim de falha',
  'bypass-start': 'Desvio por robôs',
  'bypass-end': 'Fim do desvio',
  watchdog: 'Vigia',
  'robot-stuck': 'Robô travado',
  'robot-moving': 'Robô voltou a andar',
  maintenance: 'Manutenção preditiva',
};
