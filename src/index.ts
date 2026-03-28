import type {
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

    this.#dataLayer.push = function (...args: any[]) {
      if (_this.#emitting) {
        return originalPush.apply(_this.#dataLayer, args);
      }

      const payload = args[0];

      // 1. Handle gtag()-style pushes (Arguments object)
      if (_this.#isArgumentsObject(payload)) {
        if (payload[0] === 'event' && payload[1]) {
          args[0] = _this.#scoreEvent(payload, 'gtag');
        }
        return originalPush.apply(_this.#dataLayer, args);
      }

      // 2. Handle GTM-style object literal pushes
      if (_this.#isObjectLiteral(payload)) {
        if (payload.event) {
          args[0] = _this.#scoreEvent(payload, 'gtm');
        }
        return originalPush.apply(_this.#dataLayer, args);
      }

      // 3. Pass through anything else untouched
      return originalPush.apply(_this.#dataLayer, args);
    };
  }

  #pluckFromPayload(namespace: string, payload: any, keys: string[]): Record<string, any> {
    const result: Record<string, any> = {};
    
    keys.forEach(key => {
      const value = payload[`${namespace}${key}`];
      result[key.toLowerCase()] = value !== undefined ? value : null;
    });

    return result;
  }

  #resolveLinkClickEvent(context: any): string | null {
    const link_click = 'link_click';

    if (context.element.url?.protocol === 'mailto:')
      return `email_${link_click}`;

    if (context.element.url?.protocol === 'tel:')
      return `phone_${link_click}`;

    if (context.element.url && this.#isOutboundLink(context.element.url.hostname))
      return `outbound_${link_click}`;

    if (
      context.element.node?.download ||
      /\.(?:pdf|xlsx?|docx?|txt|rtf|csv|exe|key|pp(?:s|t|tx)|7z|pkg|rar|gz|zip|avi|mov|mp4|mpe?g|wmv|midi?|mp3|wav|wma)$/.test(context.element.url?.pathname || '')
    ) return 'file_download';

    // cta_click
    // we need a way to define what a "CTA" looks like in the config. 
    // for example, we could allow the user to specify patterns for text and class names that indicate a CTA.

    return null;
  }

  #resolveEvent(payload: any) {

    if (! payload.event.startsWith('gtm.'))
      return {event: payload.event, payload};

    let event = payload.event;

    const context = {
      url: new URL(location.href),
      element: {
        node: payload['gtm.element'] || null,
      }
    };

    Object.assign(
      context.element, 
      this.#pluckFromPayload('gtm.element', payload, [
        'Url',
        'Text',
        'Classes',
      ])
    );

    switch (event) {

      case 'gtm.load':
      case 'gtm.historyChange-v2':
        event = 'page_view';
        break;

      case 'gtm.linkClick':
        event = this.#resolveLinkClickEvent(context) || 'gtm.linkClick';
        break;

      case 'gtm.video':

        context.video = this.#pluckFromPayload('gtm.video', payload, [
          'Title',
          'Provider',
          'Percent',
          'Status',
        ]);

        event = `video_${context.video.status.toLowerCase()}`;

        break;

      case 'gtm.scrollDepth':

        event = 'scroll';

        context.scroll = this.#pluckFromPayload('gtm.scroll', payload, [
          'Threshold',
          'Units',
          'Direction',
        ]);

        break;

      case 'gtm.elementVisibility':
        
        event = 'element_impression';

        context.impression = this.#pluckFromPayload('gtm.visible', payload, [
          'Ratio',
          'Time',
          'FirstTime',
          'LastTime',
        ]);

        break;

    }

    console.log('Resolving GTM event:', event, context);

    return {event, context};

  }

  #scoreEvent(payload: any, format: 'gtm' | 'gtag'): any {
    let eventName: string;
    let targetParams: any;

    if (format === 'gtag') {
      eventName = payload[1];

      // Safely ensure the parameters object exists at index 2
      if (typeof payload[2] !== 'object' || payload[2] === null) {
        payload[2] = {};

        // CRITICAL: Fix the Arguments length quirk so GTM doesn't ignore the injected params
        if (payload.length < 3) {
          payload.length = 3;
        }
      }
      targetParams = payload[2];
    } else {
      eventName = payload.event;
      targetParams = payload;
    }

    const resolved = this.#resolveEvent(targetParams);
    console.log('Resolved event:', resolved);

    const config = this.#events[resolved.event];

    if (!config)
      return payload;

    const delta = config.score(resolved.context);

    if (!Number.isInteger(delta)) {
      console.warn(`PreSignal: callback for "${eventName}" did not return an integer. Skipping.`);
      return payload; 
    }

    const session = this.#updateSession(delta);

    targetParams._preSignal = this.#buildPayload(delta, session);

    return payload;
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
    return (
      obj !== null && 
      typeof obj === 'object' && 
      Object.getPrototypeOf(obj) === Object.prototype &&
      Object.prototype.toString.call(obj) === '[object Object]' // This safely excludes '[object Arguments]'
    );
  }

  #isArgumentsObject(obj: any): boolean {
    return Object.prototype.toString.call(obj) === '[object Arguments]';
  }

  #isOutboundLink(linkHostname: string): boolean {
    try {
      const currentHost = location.hostname;

      if (linkHostname === currentHost) return false;

      const rootDomain = (host: string) => {
        const parts = host.split('.');
        const depth = parts.at(-2)?.length <= 2 ? -3 : -2;
        return parts.slice(depth).join('.');
      };

      return rootDomain(linkHostname) !== rootDomain(currentHost);
    } catch {
      return false;
    }
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
