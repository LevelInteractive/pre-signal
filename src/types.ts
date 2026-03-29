export interface SessionData {
  score: number;
  positives: number;
  negatives: number;
  total: number;
  threshold: string | null;
  excluded: boolean;
  v: string;
}

export interface PreSignalPayload {
  event?: string;
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

export interface ResolverCriteria {
  selector?: string;
  text?: string | RegExp;
  classes?: string | RegExp;
  match?: 'any' | 'all';
}

export interface PreSignalConfig {
  cookieName?: string;
  events?: Record<string, EventConfig>;
  exclusions?: string[];
  resolvers?: Record<string, Record<string, ResolverCriteria>>;
  thresholds?: Threshold[];
  maxScore?: number;
}
