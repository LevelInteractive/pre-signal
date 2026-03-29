import type {
  EventConfig,
  EventScoreCallback,
  PreSignalConfig,
  PreSignalPayload,
  ResolverCriteria,
  SessionData,
  Threshold,
} from './types';

class PreSignal
{
  static #instance: PreSignal | null = null;
  static #version = __VERSION__;

  #cookieName!: string;
  #resolvers!: Record<string, Record<string, ResolverCriteria>>;
  #events!: Record<string, EventConfig>;
  #exclusions!: Set<string>;
  #thresholds!: Threshold[];
  #maxScore!: number;
  #dataLayer!: any[];
  #emitting!: boolean;

  constructor(config: PreSignalConfig = {})
  {
    if (PreSignal.#instance) {
      return PreSignal.#instance;
    }

    PreSignal.#instance = this;
    this.#cookieName = config.cookieName || '_preSignal';
    this.#resolvers = config.resolvers || {};
    this.#events = config.events || {};
    this.#exclusions = new Set(config.exclusions || []);
    this.#thresholds = this.#sortThresholds(config.thresholds || []);
    this.#maxScore = config.maxScore || 100;
    this.#dataLayer = (window as any).dataLayer = (window as any).dataLayer || [];
    this.#emitting = false;

    if (!this.#getSession())
      this.#setSession({ score: 0, positives: 0, negatives: 0, total: 0, threshold: null, excluded: false, v: PreSignal.#version });

    this.#monkeyPatchPush();
  }

  // -- Public API --

  get score(): SessionData | null
  {
    return this.#getSession();
  }

  static get version(): string
  { 
    return PreSignal.#version; 
  }

  reset(): void
  {
    this.#setSession({ score: 0, positives: 0, negatives: 0, total: 0, threshold: null, excluded: false, v: PreSignal.#version });
  }

  registerEvent(eventName: string, score: EventScoreCallback | number): void
  {
    if (typeof score !== 'function' && !Number.isFinite(score))
      throw new Error(`PreSignal: score for "${eventName}" must be a function or a number.`);

    this.#events[eventName] = { score };
  }

  // -- DataLayer interception --

  #monkeyPatchPush(): void
  {
    const _this = this;
    const originalPush = this.#dataLayer.push;

    this.#dataLayer.push = function (...args: any[]) {
      try {
        if (_this.#emitting)
          return originalPush.apply(_this.#dataLayer, args);

        const payload = args[0];

        if (_this.#isArgumentsObject(payload)) {
          if (payload[0] === 'event' && payload[1])
            args[0] = _this.#scoreEvent(payload, 'gtag');

          return originalPush.apply(_this.#dataLayer, args);
        }

        if (_this.#isObjectLiteral(payload)) {
          if (payload.event)
            args[0] = _this.#scoreEvent(payload, 'gtm');

          return originalPush.apply(_this.#dataLayer, args);
        }

        return originalPush.apply(_this.#dataLayer, args);
      } catch (e) {
        console.warn('PreSignal: error during event processing.', e);
        return originalPush.apply(_this.#dataLayer, args);
      }
    };
  }

  // -- Event resolution --

  #resolveEvent(eventName: string, payload: any)
  {
    if (! eventName.startsWith('gtm.'))
      return {event: eventName, context: { url: new URL(location.href) }};

    let event = eventName;

    const context: Record<string, any> = {
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

    if (context.element.text)
      context.element.text = context.element.text.trim().toLowerCase();

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

    if (event === eventName) {
      event = this.#runCustomResolvers(eventName, context) || event;
    }

    return {event, context};
  }

  #resolveLinkClickEvent(context: any): string | null
  {
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

    return null;
  }

  #pluckFromPayload(namespace: string, payload: any, keys: string[]): Record<string, any>
  {
    const result: Record<string, any> = {};

    keys.forEach(key => {
      const value = payload[`${namespace}${key}`];
      const normalizedKey = key.toLowerCase();

      if (value === undefined) {
        result[normalizedKey] = null;
        return;
      }

      if (normalizedKey === 'url' && typeof value === 'string') {
        try {
          result[normalizedKey] = new URL(value);
        } catch {
          result[normalizedKey] = null;
        }
        return;
      }

      result[normalizedKey] = value;
    });

    return result;
  }

  // -- Scoring --

  #scoreEvent(payload: any, format: 'gtm' | 'gtag'): any
  {
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

    const session = this.#getSession()!;

    if (session.excluded)
      return payload;

    const resolved = this.#resolveEvent(eventName, targetParams);

    if (this.#exclusions.has(resolved.event)) {
      this.#excludeSession(resolved.event, session);
      targetParams.preSignal = { event: resolved.event, ...this.#buildPayload(0, session) };
      return payload;
    }

    const config = this.#events[resolved.event];

    if (!config)
      return payload;

    const delta = typeof config.score === 'function'
      ? config.score(resolved.context)
      : config.score;

    if (!Number.isFinite(delta)) {
      console.warn(`PreSignal: score for "${eventName}" must resolve to a number. Skipping.`);
      return payload;
    }

    const updatedSession = this.#updateSession(resolved.event, delta);

    targetParams.preSignal = { event: resolved.event, ...this.#buildPayload(delta, updatedSession) };

    return payload;
  }

  #updateSession(event: string, delta: number): SessionData
  {
    const session = this.#getSession()!;
    const previousThreshold = session.threshold;

    session.score = this.#clamp(session.score + delta);
    session.total += 1;

    if (delta > 0) session.positives += 1;
    if (delta < 0) session.negatives += 1;

    session.threshold = this.#resolveThreshold(this.#toPercentile(session.score));

    this.#setSession(session);

    this.#emit('score.update', { event, ...this.#buildPayload(delta, session) });

    if (session.threshold !== previousThreshold)
      this.#emitThreshold(event, delta, session, previousThreshold);

    return session;
  }

  #buildPayload(delta: number, session: SessionData): PreSignalPayload
  {
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

  #clamp(score: number): number
  {
    return Math.round(Math.min(Math.max(score, 0), this.#maxScore) * 100) / 100;
  }

  #toPercentile(score: number): number
  {
    return Math.round((score / this.#maxScore) * 100);
  }

  // -- Thresholds --

  #sortThresholds(thresholds: Threshold[]): Threshold[]
  {
    return [...thresholds].sort((a, b) => a[1] - b[1]);
  }

  #resolveThreshold(percentile: number): string | null
  {
    let matched: string | null = null;

    for (const [name, min] of this.#thresholds) {
      if (percentile >= min)
        matched = name;
    }

    return matched;
  }

  #excludeSession(event: string, session: SessionData): void
  {
    session.excluded = true;
    this.#setSession(session);

    this.#emitting = true;

    this.#dataLayer.push({
      event: 'preSignal.exclude',
      preSignal: this.#buildPayload(0, session),
    });

    this.#emit('exclude', { event, ...this.#buildPayload(0, session) });

    this.#emitting = false;
  }

  #emitThreshold(event: string, delta: number, session: SessionData, previousThreshold: string | null): void
  {
    this.#emitting = true;

    this.#dataLayer.push({
      event: 'preSignal.threshold',
      preSignal: {
        ...this.#buildPayload(delta, session),
        threshold: {
          name: session.threshold,
          previous: previousThreshold,
        }
      }
    });

    this.#emit('threshold.update', {
      event,
      ...this.#buildPayload(delta, session),
      threshold: {
        name: session.threshold,
        previous: previousThreshold,
      }
    });

    this.#emitting = false;
  }

  // -- CustomEvent emission --

  #emit(name: string, detail: any): void
  {
    window.dispatchEvent(new CustomEvent(`pre-signal:${name}`, { detail }));
  }

  // -- Session persistence --

  #getSession(): SessionData | null
  {
    const raw = this.#getCookie(this.#cookieName);
    
    if (!raw) 
      return null;

    try {
      const session = JSON.parse(decodeURIComponent(raw));

      if (session.v !== PreSignal.#version)
        return null;

      return session;
    } catch (e) {
      console.warn('PreSignal: failed to parse session cookie.', e);
      return null;
    }
  }

  #setSession(data: SessionData): void
  {
    const value = encodeURIComponent(JSON.stringify(data));
    document.cookie = `${this.#cookieName}=${value};path=/;SameSite=Lax`;
  }

  #getCookie(name: string): string | null
  {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? match[1] : null;
  }

  // -- Guards & detection --

  #isObjectLiteral(obj: any): boolean
  {
    return (
      obj !== null &&
      typeof obj === 'object' &&
      Object.getPrototypeOf(obj) === Object.prototype &&
      Object.prototype.toString.call(obj) === '[object Object]' // This safely excludes '[object Arguments]'
    );
  }

  #isArgumentsObject(obj: any): boolean
  {
    return Object.prototype.toString.call(obj) === '[object Arguments]';
  }

  #runCustomResolvers(eventName: string, context: any): string | null
  {
    const resolvers = this.#resolvers[eventName];

    if (!resolvers)
      return null;

    for (const [resolvedName, criteria] of Object.entries(resolvers)) {
      const results: boolean[] = [];
      let resolvedNode: Element | null | undefined = null;

      if (criteria.selector !== undefined) {
        resolvedNode = context.element.node?.closest(criteria.selector);
        results.push(!!resolvedNode);
      }

      if (criteria.text !== undefined) {
        const pattern = criteria.text instanceof RegExp ? criteria.text : new RegExp(criteria.text, 'i');
        results.push(pattern.test(context.element.text || ''));
      }

      if (criteria.classes !== undefined) {
        const pattern = criteria.classes instanceof RegExp ? criteria.classes : new RegExp(criteria.classes, 'i');
        results.push(pattern.test(context.element.classes || ''));
      }

      if (results.length === 0)
        continue;

      const match = criteria.match || 'any';
      const passed = match === 'all'
        ? results.every(Boolean)
        : results.some(Boolean);

      if (passed) {
        if (resolvedNode) {
          context.element.node = resolvedNode;
          context.element.text = resolvedNode.textContent?.trim().toLowerCase() || null;
          context.element.classes = resolvedNode.className || null;

          let url: URL | null = null;
          if (resolvedNode.tagName === 'A' && (resolvedNode as HTMLAnchorElement).href) {
            try {
              url = new URL((resolvedNode as HTMLAnchorElement).href);
            } catch {
              url = null;
            }
          }
          context.element.url = url;
        }

        return resolvedName;
      }
    }

    return null;
  }

  #isOutboundLink(linkHostname: string): boolean
  {
    try {
      const currentHost = location.hostname;

      if (linkHostname === currentHost) return false;

      const rootDomain = (host: string) => {
        const parts = host.split('.');
        const depth = (parts.at(-2)?.length ?? 0) <= 2 ? -3 : -2;
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
  EventConfig,
  EventScoreCallback,
  PreSignalConfig,
  PreSignalPayload,
  ResolverCriteria,
  SessionData,
  Threshold,
  ThresholdPayload,
} from './types';
