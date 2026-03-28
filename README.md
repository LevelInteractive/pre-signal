# PreSignal

[![GZip size](https://img.badgesize.io/levelinteractive/pre-signal/main/dist/pre-signal.js?compression=gzip)](https://github.com/levelinteractive/pre-signal/main/dist/pre-signal.js)

A lightweight session engagement scoring utility that monkey-patches the `dataLayer` to score user interactions in real-time. Designed to feed normalized engagement signals back to advertising platforms for value-based bidding and audience quality optimization.

## How it works

PreSignal intercepts the global `dataLayer.push()` method and scores each event against a configurable set of rules. Every scored event updates a session cookie with a running total, and each `dataLayer.push()` payload is augmented with the current score, percentile, and threshold.

When a user's engagement crosses a threshold boundary (e.g. `cold` → `warm`), PreSignal emits a `preSignal.threshold` event to the dataLayer — which can be used as a GTM trigger to fire conversion tags, audience signals, or any other downstream action.

### Supported event formats

PreSignal handles both common `dataLayer` push formats:

- **GTM-style object literals** — `dataLayer.push({ event: 'form_submit', ... })` — the payload is augmented with a `preSignal` object before reaching GTM.
- **gtag()-style arguments** — `gtag('event', 'purchase', { ... })` — the session is scored but the arguments object is passed through unmodified.

### Session cookie

Session state is stored in a JSON cookie (default: `preSignal`) with no `max-age` or `expires`, so it expires when the browser session ends. The cookie tracks:

| Key | Description |
|---|---|
| `score` | Raw cumulative score, clamped between `0` and `maxScore` |
| `positives` | Count of events that returned a positive delta |
| `negatives` | Count of events that returned a negative delta |
| `total` | Total number of scored events |
| `threshold` | Name of the current threshold (e.g. `'warm'`) |
| `excluded` | Whether the session has been excluded from scoring |

## How to use

### 1. Install in GTM w/ Custom HTML Tag

Create a Custom HTML tag in GTM and set it to fire on **All Pages** (or your preferred trigger). Paste the following:

```html
<script>
(function(s,i,g,n,a,l){
  a=i.createElement(g);a.onload=n;a.defer=1;
  a.src="https://cdn.jsdelivr.net/gh/levelinteractive/pre-signal@"+s+"/dist/pre-signal.js";
  l=i.getElementsByTagName(g)[0];l.parentNode.insertBefore(a,l);
})(document, 'script', "latest", function() {
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
    ['D', 20],
    ['C', 40],
    ['B', 60],
    ['A', 80],
    ['S', 100]
  ],
  ctaPatterns: {
    text: 'get started|sign up|request a demo',
    classes: 'btn|button|cta',
  },
  exclusions: ['login', 'purchase'],
  events: {
    page_view: { score: 1 },
    cta_click: { score: 10 },
    file_download: { score: 5 },
    scroll: {
      score: function(context) {
        return context.scroll.threshold >= 50 ? 3 : 1;
      }
    },
    form_submit: { score: 100 },
  }
});
```

> [!NOTE]
> Google Tag Manager doesn't support most ES6/2015 syntax in Custom HTML tags, if you have an LLM try to create a scoring rubric for you make sure you give it that context.

### 3. Use threshold events in GTM

Create a **Custom Event** trigger in GTM:

| Setting | Value |
|---|---|
| Event name | `preSignal.threshold` |
| Use regex matching | No |

This trigger fires every time a user crosses a threshold boundary. You can access the payload via a **Data Layer Variable** pointed at `preSignal` to read values like `preSignal.percentile`, `preSignal.threshold.name`, or `preSignal.threshold.previous`.

## Configuration

### `maxScore`

The ceiling for the raw score. The percentile is calculated as `(score / maxScore) * 100` and clamped between 0–100. Choose a value that represents your ideal engaged session — if your best-case user triggers ~120 points worth of events, set `maxScore: 120`.

### `thresholds`

An array of `[name, percentile]` tuples, where `percentile` is the minimum engagement percentile required to enter that tier. Thresholds are evaluated in ascending order.

The following example configures a linear S-D style "tier list".

```javascript
thresholds: [
  ['D', 20],  // 20-39%
  ['C', 40],  // 40-59%
  ['B', 60],  // 60-79%
  ['A', 80],  // 80-99%  
  ['S', 100]  // 100%+
]
```

### `ctaPatterns`

Optional. Defines patterns for classifying link clicks as CTA clicks. Both fields accept pipe-delimited strings used as case-insensitive regex patterns. By default this is treated as an `OR` via a `match: 'any'` default. You can change it to an `AND` by setting `match: 'all'`. If the pattern match results in `true`, the event is resolved to `cta_click`. 

```javascript
ctaPatterns: {
  text: 'get started|sign up|request a demo',  // partial match against link text
  classes: 'btn|button|cta',                   // partial match against element classes
  match: 'any',                                // Default: 'any' (OR), 'all' (AND)
}
```

### `exclusions`

Optional. An array of resolved event names that should immediately exclude the session from further scoring. When an exclusion event fires, PreSignal:

1. Sets the `excluded` flag on the session cookie
2. Emits a `preSignal.exclude` event to the dataLayer
3. Stops scoring all subsequent events for the remainder of the session

This is useful for filtering out sessions where the user has already converted (e.g. logged in, completed a purchase) — signals that make engagement scoring irrelevant.

```javascript
exclusions: ['login']
```

The exclusion is permanent for the session. Calling `instance.reset()` will clear the exclusion flag and resume scoring.

### `events`

An object where each key is an event name (see [Auto-Event Resolution](#auto-event-resolution)) and the value is an object with a `score` property. The `score` can be either:

- **An integer** — a static score applied every time the event fires.
- **A callback function** — receives a `context` object and must return an integer (positive or negative).

```javascript
events: {
  // Static integer score
  page_view: { score: 1 },
  cta_click: { score: 10 },

  // Callback for conditional scoring
  scroll: {
    score: function(context) {
      return context.scroll.threshold >= 75 ? 5 : 1;
    }
  }
}
```

Returning a non-integer from a callback will log a warning and skip scoring for that event.

### `cookieName`

Optional. Defaults to `'preSignal'`. The name of the session cookie used to persist the score.

## Auto-Event Resolution

PreSignal automatically resolves GTM auto-events (`gtm.*`) into more descriptive event names. When registering events in the `events` config, use the **resolved** names below — not the raw GTM event names.

During resolution, relevant auto-event variables are extracted from the dataLayer payload and organized into a `context` object that is passed to `score` callbacks.

### Resolved event names

| GTM Event | Resolved Name | Context Properties |
|---|---|---|
| `gtm.load` | `page_view` | `context.url` |
| `gtm.historyChange-v2` | `page_view` | `context.url` |
| `gtm.linkClick` | See [Link Click Resolution](#link-click-resolution) | `context.url`, `context.element` |
| `gtm.video` | `video_{status}` (e.g. `video_start`, `video_complete`) | `context.url`, `context.video` |
| `gtm.scrollDepth` | `scroll` | `context.url`, `context.scroll` |
| `gtm.elementVisibility` | `element_impression` | `context.url`, `context.impression` |

Non-GTM events (e.g. custom `dataLayer.push({ event: 'form_submit' })`) pass through with their original name. If a `gtm.*` event doesn't resolve to a named event (e.g. an unclassified `gtm.linkClick`), the raw `gtm.*` event name is used to look up the scoring config — so you can still register a handler for `'gtm.linkClick'` as a catch-all for link clicks that don't match any specific classification.

### Link click resolution

`gtm.linkClick` events are further classified based on the link's attributes:

| Resolved Name | Condition |
|---|---|
| `email_link_click` | `mailto:` protocol |
| `phone_link_click` | `tel:` protocol |
| `outbound_link_click` | Link hostname differs from the current site's root domain |
| `file_download` | Link has a `download` attribute, or pathname ends with a known file extension (pdf, docx, xlsx, zip, mp4, etc.) |
| `cta_click` | Link text or classes match the patterns defined in the [`cta`](#cta) config |

If none of the above match, the event remains as `gtm.linkClick`.

### Context object

All `score` callbacks receive a `context` object. The properties available depend on the event type:

**`context.url`** — always present. A `URL` object of the current page.

**`context.element`** — present for link click events.

| Property | Description |
|---|---|
| `context.element.node` | The DOM element that was clicked |
| `context.element.url` | Parsed `URL` object of the link href |
| `context.element.text` | The link's text content (lowercased) |
| `context.element.classes` | The element's class attribute |

**`context.video`** — present for video events.

| Property | Description |
|---|---|
| `context.video.title` | Video title |
| `context.video.provider` | Video provider (e.g. `'youtube'`) |
| `context.video.percent` | Playback percentage |
| `context.video.status` | Video status (e.g. `'start'`, `'progress'`, `'complete'`) |

**`context.scroll`** — present for scroll events.

| Property | Description |
|---|---|
| `context.scroll.threshold` | Scroll depth threshold that was crossed |
| `context.scroll.units` | Unit of measurement (e.g. `'percent'`) |
| `context.scroll.direction` | Scroll direction |

**`context.impression`** — present for element visibility events.

| Property | Description |
|---|---|
| `context.impression.ratio` | Visible ratio of the element |
| `context.impression.time` | Time visible |
| `context.impression.firsttime` | Whether this is the first impression |
| `context.impression.lasttime` | Last time the element was visible |

## Event payloads

### Augmented dataLayer events

Every scored GTM-style event gets a `preSignal` object appended:

```javascript
{
  event: 'form_submit',
  // ... original payload ...
  preSignal: {
    delta: 10,
    score: 45,
    percentile: 38,
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
  preSignal: {
    delta: 15,
    score: 60,
    percentile: 50,
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

### Exclusion events

Emitted when a session is excluded due to a matching event in the `exclusions` config:

```javascript
{
  event: 'preSignal.exclude',
  preSignal: {
    delta: 0,
    score: 30,
    percentile: 25,
    threshold: 'warm',
    events: {
      positives: 3,
      negatives: 0,
      total: 3
    }
  }
}
```

## Public API

### `instance.score`

Getter that returns the current session object from the cookie.

```javascript
let session = ps.score;
// { score: 45, positives: 4, negatives: 1, total: 5, threshold: 'warm', excluded: false }
```

### `instance.reset()`

Resets the session cookie to zero.

### `instance.registerEvent(eventName, score)`

Register an event after initialization. The `score` argument can be a function or an integer.

```javascript
ps.registerEvent('video_complete', 5);

ps.registerEvent('scroll', function(context) {
  return context.scroll.threshold >= 90 ? 10 : 2;
});
```
