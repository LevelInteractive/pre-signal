/**
 * github.com/LevelInteractive/pre-signal
 * Copyright (c) 2026 Level Agency, Inc. All rights reserved.
 */
class PreSignal
{
  #cookieName;
  #events;
  #thresholds;
  #maxScore;
  #dataLayer;
  #emitting;

  constructor(config = {})
  {
    this.#cookieName = config.cookieName || '_preSignal';
    this.#events = config.events || {};
    this.#thresholds = this.#sortThresholds(config.thresholds || []);
    this.#maxScore = config.maxScore || 100;
    this.#dataLayer = window.dataLayer = window.dataLayer || [];
    this.#emitting = false;

    if (!this.#getSession())
      this.#setSession({ score: 0, positives: 0, negatives: 0, total: 0, threshold: null });

    this.#monkeyPatchPush();
  }

  // -- Public API --

  get score()
  {
    return this.#getSession();
  }

  reset()
  {
    this.#setSession({ score: 0, positives: 0, negatives: 0, total: 0, threshold: null });
  }

  registerEvent(eventName, callback)
  {
    if (typeof callback !== 'function')
      throw new Error(`PreSignal: callback for "${eventName}" must be a function returning an integer.`);

    this.#events[eventName] = { score: callback };
  }

  // -- Core --

  #monkeyPatchPush()
  {
    let _this = this;
    let originalPush = this.#dataLayer.push;

    this.#dataLayer.push = function ()
    {
      let args = arguments;

      // If we're emitting a threshold event, pass through to avoid recursion
      if (_this.#emitting)
        return originalPush.apply(_this.#dataLayer, args);

      // Handle GTM-style object literal pushes
      if (_this.#isObjectLiteral(args[0])) {
        let payload = args[0];

        if (payload.event && _this.#events[payload.event])
          payload = _this.#scoreEvent(payload, new URL(location.href), payload['gtm.element'] || null);

        return originalPush.call(_this.#dataLayer, payload);
      }

      // Handle gtag()-style pushes (arguments object)
      if (_this.#isArgumentsObject(args[0])) {
        let command = args[0];

        if (command[0] === 'event' && command[1] && _this.#events[command[1]])
          _this.#scoreGtagEvent(command);

        return originalPush.apply(_this.#dataLayer, args);
      }

      // Anything else, pass through untouched
      return originalPush.apply(_this.#dataLayer, args);
    };
  }

  #scoreEvent(payload, url, element = null)
  {
    let eventName = payload.event;
    let config = this.#events[eventName];
    let delta = config.score(payload, url, element);

    if (!Number.isInteger(delta)) {
      console.warn(`PreSignal: callback for "${eventName}" did not return an integer. Skipping.`);
      return payload;
    }

    let session = this.#updateSession(delta);

    // Augment the payload with scoring data
    payload._preSignal = this.#buildPayload(delta, session);

    return payload;
  }

  #scoreGtagEvent(command)
  {
    let eventName = command[1];
    let params = command[2] || {};
    let config = this.#events[eventName];
    let delta = config.score(params);

    if (!Number.isInteger(delta)) {
      console.warn(`PreSignal: callback for "${eventName}" did not return an integer. Skipping.`);
      return;
    }

    this.#updateSession(delta);
  }

  #updateSession(delta)
  {
    let session = this.#getSession();
    let previousThreshold = session.threshold;

    session.score = this.#clamp(session.score + delta);
    session.total += 1;

    if (delta > 0) session.positives += 1;
    if (delta < 0) session.negatives += 1;

    session.threshold = this.#resolveThreshold(this.#toPercentage(session.score));

    this.#setSession(session);

    if (session.threshold !== previousThreshold)
      this.#emitThreshold(delta, session, previousThreshold);

    return session;
  }

  // -- Scoring helpers --

  #clamp(score)
  {
    return Math.min(Math.max(score, 0), this.#maxScore);
  }

  #toPercentage(score)
  {
    return Math.round((score / this.#maxScore) * 100);
  }

  // -- Thresholds --

  #sortThresholds(thresholds)
  {
    return [...thresholds].sort((a, b) => a[1] - b[1]);
  }

  #resolveThreshold(percentage)
  {
    let matched = null;

    for (let [name, min] of this.#thresholds) {
      if (percentage >= min)
        matched = name;
    }

    return matched;
  }

  #emitThreshold(delta, session, previousThreshold)
  {
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

  #buildPayload(delta, session)
  {
    return {
      delta,
      score: session.score,
      percentage: this.#toPercentage(session.score),
      threshold: session.threshold,
      events: {
        positives: session.positives,
        negatives: session.negatives,
        total: session.total,
      }
    };
  }

  // -- Cookie helpers --

  #getSession()
  {
    let raw = this.#getCookie(this.#cookieName);
    if (!raw) return null;

    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch (e) {
      console.warn('PreSignal: failed to parse session cookie.', e);
      return null;
    }
  }

  #setSession(data)
  {
    let value = encodeURIComponent(JSON.stringify(data));
    document.cookie = `${this.#cookieName}=${value};path=/;SameSite=Lax`;
  }

  #getCookie(name)
  {
    let match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? match[1] : null;
  }

  // -- Type checks --

  #isObjectLiteral(obj)
  {
    return obj !== null && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype;
  }

  #isArgumentsObject(obj)
  {
    return Object.prototype.toString.call(obj) === '[object Arguments]';
  }
}