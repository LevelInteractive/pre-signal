# PreSignal

A lightweight session engagement scoring utility that monkey-patches the `dataLayer` to score user interactions in real-time. Designed to feed normalized engagement signals back to advertising platforms for value-based bidding and audience quality optimization.

## How it works

PreSignal intercepts the global `dataLayer.push()` method and scores each event against a configurable set of rules. Every scored event updates a session cookie with a running total, and each `dataLayer.push()` payload is augmented with the current score, percentage, and threshold.

When a user's engagement crosses a threshold boundary (e.g. `cold` → `warm`), PreSignal emits a `preSignal.threshold` event to the dataLayer — which can be used as a GTM trigger to fire conversion tags, audience signals, or any other downstream action.

### Supported event formats

PreSignal handles both common `dataLayer` push formats:

- **GTM-style object literals** — `dataLayer.push({ event: 'form_submit', ... })` — the payload is augmented with a `_preSignal` object before reaching GTM.
- **gtag()-style arguments** — `gtag('event', 'purchase', { ... })` — the session is scored but the arguments object is passed through unmodified.

### Session cookie

Session state is stored in a JSON cookie (default: `_preSignal`) with no `max-age` or `expires`, so it expires when the browser session ends. The cookie tracks:

| Key | Description |
|---|---|
| `score` | Raw cumulative score, clamped between `0` and `maxScore` |
| `positives` | Count of events that returned a positive delta |
| `negatives` | Count of events that returned a negative delta |
| `total` | Total number of scored events |
| `threshold` | Name of the current threshold (e.g. `'warm'`) |

## How to use

### 1. Install in GTM w/ Custom HTML Tag

Create a Custom HTML tag in GTM and set it to fire on **All Pages** (or your preferred trigger). Paste the following:

```html
<script>
(function(s,i,g,n,a,l){
a=i.createElement(g);a.onload=n;a.defer=1;
a.src="https://cdn.jsdelivr.net/gh/levelinteractive/pre-signal@latest/src/pre-signal.js";
l=i.getElementsByTagName(g)[0];l.parentNode.insertBefore(a,l);
})(window, document, 'script', function() {

  // We'll initialize our PreSignal instance here in step #2
  // new PreSignal(...);

});
</script>
```

### 2. Initialize an instance in the loader

Replace the comment in the loader callback with your configuration:

```javascript
new PreSignal({
  maxScore: 120,
  thresholds: [
    ['cold',    0],
    ['warm',    25],
    ['hot',     50],
    ['on_fire', 75],
  ],
  events: {
    'gtm.load': {
      score: function(payload, url) { 
        return 1; 
      }
    },
    'gtm.linkClick': {
      score: function(payload, url, element) { 
        console.dir(payload, url, element);
        return 10; 
      }
    },
    'lvl.form_submit': {
      score: function(payload, url) { 
        return 100; 
      }
    },
  }
});
```

### 3. Use threshold events in GTM

Create a **Custom Event** trigger in GTM:

| Setting | Value |
|---|---|
| Event name | `preSignal.threshold` |
| Use regex matching | No |

This trigger fires every time a user crosses a threshold boundary. You can access the payload via a **Data Layer Variable** pointed at `_preSignal` to read values like `_preSignal.percentage`, `_preSignal.threshold.name`, or `_preSignal.threshold.previous`.

## Configuration

### `maxScore`

The ceiling for the raw score. The percentage is calculated as `(score / maxScore) * 100` and clamped between 0–100. Choose a value that represents your ideal engaged session — if your best-case user triggers ~120 points worth of events, set `maxScore: 120`.

### `thresholds`

An array of `[name, percentage]` tuples, where `percentage` is the minimum engagement percentage required to enter that tier. Thresholds are evaluated in ascending order.

```javascript
thresholds: [
  ['cold',    0],   // 0–24%
  ['warm',    25],  // 25–49%
  ['hot',     50],  // 50–74%
  ['on_fire', 75],  // 75–100%
]
```

### `events`

An object where each key is a `dataLayer` event name and the value is an object with a `score` callback. The callback receives up to three arguments and must return an integer (positive or negative):

```javascript
events: {
  'event_name': {
    score: function(payload, url, element) {
      // payload - the dataLayer event object
      // url     - a URL object of the current page
      // element - the gtm.element if present, otherwise null
      return 10; // must return an integer
    }
  }
}
```

Returning a non-integer will log a warning and skip scoring for that event.

### `cookieName`

Optional. Defaults to `'_preSignal'`. The name of the session cookie used to persist the score.

## Event payloads

### Augmented dataLayer events

Every scored GTM-style event gets a `_preSignal` object appended:

```javascript
{
  event: 'gtm.linkClick',
  // ... original payload ...
  _preSignal: {
    delta: 10,
    score: 45,
    percentage: 38,
    threshold: 'warm',
    events: {
      positives: 4,
      negatives: 1,
      total: 5
    }
  }
}
```

### Threshold events

Emitted whenever the session crosses a threshold boundary (in either direction):

```javascript
{
  event: 'preSignal.threshold',
  _preSignal: {
    delta: 15,
    score: 60,
    percentage: 50,
    threshold: 'hot',
    events: {
      positives: 6,
      negatives: 1,
      total: 7
    },
    threshold: {
      name: 'hot',
      previous: 'warm'
    }
  }
}
```

## Public API

### `instance.score`

Getter that returns the current session object from the cookie.

```javascript
let session = ps.score;
// { score: 45, positives: 4, negatives: 1, total: 5, threshold: 'warm' }
```

### `instance.reset()`

Resets the session cookie to zero.

### `instance.registerEvent(eventName, callback)`

Register an event after initialization:

```javascript
ps.registerEvent('video_complete', function(payload, url) {
  return 5;
});
```