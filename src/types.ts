export interface SessionData {
  score: number;
  positives: number;
  negatives: number;
  total: number;
  threshold: string | null;
}

export interface PreSignalPayload {
  delta: number;
  score: number;
  percentile: number;
  threshold: string | null;
  events: {
    positives: number;
    negatives: number;
    total: number;
  };
}

export interface ThresholdPayload extends Omit<PreSignalPayload, 'threshold'> {
  threshold: {
    name: string | null;
    previous: string | null;
  };
}

export type Threshold = [string, number];

export type EventScoreCallback = (payload: any, url?: URL) => number;

export interface EventConfig {
  score: EventScoreCallback | number;
}

export interface CtaConfig {
  text?: string;
  classes?: string;
}

export interface PreSignalConfig {
  cookieName?: string;
  cta?: CtaConfig;
  events?: Record<string, EventConfig>;
  thresholds?: Threshold[];
  maxScore?: number;
}
