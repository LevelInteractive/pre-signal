import type {
  AevObject,
  EventConfig,
  EventScoreCallback,
  PreSignalConfig,
  PreSignalPayload,
  SessionData,
  Threshold,
} from './types';

class PreSignal {
  static #instance: PreSignal | null = null;

  #cookieName!: string;
  #events!: Record<string, EventConfig>;
  #thresholds!: Threshold[];
  #maxScore!: number;
  #dataLayer!: any[];
  #emitting!: boolean;

  constructor(config: PreSignalConfig = {}) {
    if (PreSignal.#instance) {
      console.warn('PreSignal: instance already exists. Returning existing instance.');
      return PreSignal.#instance;
    }

    PreSignal.#instance = this;
    this.#cookieName = config.cookieName || '_preSignal';
    this.#events = config.events || {};
    this.#thresholds = this.#sortThresholds(config.thresholds || []);
    this.#maxScore = config.maxScore || 100;
    this.#dataLayer = (window as any).dataLayer = (window as any).dataLayer || [];
    this.#emitting = false;

    if (!this.#getSession())
      this.#setSession({ score: 0, positives: 0, negatives: 0, total: 0, threshold: null });

    this.#monkeyPatchPush();
  }

  // -- Public API --

  get score(): SessionData | null {
    return this.#getSession();
  }

  reset(): void {
    this.#setSession({ score: 0, positives: 0, negatives: 0, total: 0, threshold: null });
  }

  registerEvent(eventName: string, callback: EventScoreCallback): void {
    if (typeof callback !== 'function')
      throw new Error(`PreSignal: callback for "${eventName}" must be a function returning an integer.`);

    this.#events[eventName] = { score: callback };
  }

  // -- Core --

  #monkeyPatchPush(): void {
    const _this = this;
    const originalPush = this.#dataLayer.push;

    this.#dataLayer.push = function () {
      const args = arguments;

      // If we're emitting a threshold event, pass through to avoid recursion
      if (_this.#emitting)
        return originalPush.apply(_this.#dataLayer, args as any);

      // Handle GTM-style object literal pushes
      if (_this.#isObjectLiteral(args[0])) {
        let payload = args[0];

        if (payload.event && _this.#events[payload.event])
          payload = _this.#scoreEvent(payload);

        return originalPush.call(_this.#dataLayer, payload);
      }

      // Handle gtag()-style pushes (arguments object)
      if (_this.#isArgumentsObject(args[0])) {
        const command = args[0];

        if (command[0] === 'event' && command[1] && _this.#events[command[1]])
          _this.#scoreGtagEvent(command);

        return originalPush.apply(_this.#dataLayer, args as any);
      }

      // Anything else, pass through untouched
      return originalPush.apply(_this.#dataLayer, args as any);
    };
  }

  #makeAevObject(payload: any): AevObject {
    return {
      element: payload['gtm.element'] || null,
      text: payload['gtm.elementText'] ? payload['gtm.elementText'].toLowerCase() : null,
      url: payload['gtm.elementUrl'] ? new URL(payload['gtm.elementUrl']) : null,
      class: payload['gtm.elementClasses'] || null,
      id: payload['gtm.elementId'] || null,
    };
  }

  #scoreEvent(payload: any): any {
    const eventName = payload.event;
    const config = this.#events[eventName];

    payload._aev = this.#makeAevObject(payload);

    const delta = config.score(payload, new URL(location.href));

    if (!Number.isInteger(delta)) {
      console.warn(`PreSignal: callback for "${eventName}" did not return an integer. Skipping.`);
      return payload;
    }

    const session = this.#updateSession(delta);

    // Augment the payload with scoring data
    payload._preSignal = this.#buildPayload(delta, session);

    return payload;
  }

  #scoreGtagEvent(command: any): void {
    const eventName = command[1];
    const params = command[2] || {};
    const config = this.#events[eventName];
    const delta = config.score(params);

    if (!Number.isInteger(delta)) {
      console.warn(`PreSignal: callback for "${eventName}" did not return an integer. Skipping.`);
      return;
    }

    this.#updateSession(delta);
  }

  #updateSession(delta: number): SessionData {
    const session = this.#getSession()!;
    const previousThreshold = session.threshold;

    session.score = this.#clamp(session.score + delta);
    session.total += 1;

    if (delta > 0) session.positives += 1;
    if (delta < 0) session.negatives += 1;

    session.threshold = this.#resolveThreshold(this.#toPercentile(session.score));

    this.#setSession(session);

    if (session.threshold !== previousThreshold)
      this.#emitThreshold(delta, session, previousThreshold);

    return session;
  }

  // -- Scoring helpers --

  #clamp(score: number): number {
    return Math.min(Math.max(score, 0), this.#maxScore);
  }

  #toPercentile(score: number): number {
    return Math.round((score / this.#maxScore) * 100);
  }

  // -- Thresholds --

  #sortThresholds(thresholds: Threshold[]): Threshold[] {
    return [...thresholds].sort((a, b) => a[1] - b[1]);
  }

  #resolveThreshold(percentile: number): string | null {
    let matched: string | null = null;

    for (const [name, min] of this.#thresholds) {
      if (percentile >= min)
        matched = name;
    }

    return matched;
  }

  #emitThreshold(delta: number, session: SessionData, previousThreshold: string | null): void {
    this.#emitting = true;

    this.#dataLayer.push({
      event: 'preSignal.threshold',
      _preSignal: {
        ...this.#buildPayload(delta, session),
        threshold: {
          name: session.threshold,
          previous: previousThreshold,
        }
      }
    });

    this.#emitting = false;
  }

  #buildPayload(delta: number, session: SessionData): PreSignalPayload {
    return {
      delta,
      score: session.score,
      percentile: this.#toPercentile(session.score),
      threshold: session.threshold,
      events: {
        positives: session.positives,
        negatives: session.negatives,
        total: session.total,
      }
    };
  }

  // -- Cookie helpers --

  #getSession(): SessionData | null {
    const raw = this.#getCookie(this.#cookieName);
    if (!raw) return null;

    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch (e) {
      console.warn('PreSignal: failed to parse session cookie.', e);
      return null;
    }
  }

  #setSession(data: SessionData): void {
    const value = encodeURIComponent(JSON.stringify(data));
    document.cookie = `${this.#cookieName}=${value};path=/;SameSite=Lax`;
  }

  #getCookie(name: string): string | null {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? match[1] : null;
  }

  // -- Type checks --

  #isObjectLiteral(obj: any): boolean {
    return obj !== null && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype;
  }

  #isArgumentsObject(obj: any): boolean {
    return Object.prototype.toString.call(obj) === '[object Arguments]';
  }
}

// Attach to window for script-tag usage
(window as any).PreSignal = PreSignal;

// ESM export
export default PreSignal;
export type {
  AevObject,
  EventConfig,
  EventScoreCallback,
  PreSignalConfig,
  PreSignalPayload,
  SessionData,
  Threshold,
  ThresholdPayload,
} from './types';
