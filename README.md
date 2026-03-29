# PreSignal

[![GZip size](https://img.badgesize.io/levelinteractive/pre-signal/main/dist/pre-signal.js?compression=gzip)](https://github.com/levelinteractive/pre-signal/main/dist/pre-signal.js)

A lightweight session engagement scoring utility that monkey-patches the `dataLayer` to score user interactions in real-time. Designed to feed normalized engagement signals back to advertising platforms for value-based bidding and audience quality optimization.

## How it works

PreSignal intercepts the global `dataLayer.push()` method and scores each event against a configurable set of rules. Every scored event updates a session cookie with a running total, and each `dataLayer.push()` payload is augmented with the current score, percentile, and threshold.

When a user's engagement crosses a threshold boundary (e.g. `D` → `C`), PreSignal emits a `preSignal.threshold` event to the dataLayer — which can be used as a GTM trigger to fire conversion tags, audience signals, or any other downstream action.

### Supported event formats

PreSignal handles both common `dataLayer` push formats:

- **GTM-style object literals** — `dataLayer.push({ event: 'form_submit', ... })` — the payload is augmented with a `preSignal` object before reaching GTM.
- **gtag()-style arguments** — `gtag('event', 'purchase', { ... })` — the session is scored and the parameters object is augmented with a `preSignal` property.

### Session cookie

Session state is stored in a JSON cookie (default: `_preSignal`) with no `max-age` or `expires`, so it expires when the browser session ends. The cookie tracks:

| Key | Description |
|---|---|
| `score` | Raw cumulative score, clamped between `0` and `maxScore` |
| `positives` | Count of events that returned a positive delta |
| `negatives` | Count of events that returned a negative delta |
| `total` | Total number of scored events |
| `threshold` | Name of the current threshold (e.g. `'C'`), or `null` if no threshold has been reached |
| `excluded` | Whether the session has been excluded from scoring |

## How to use

### 1. Install in GTM w/ Custom HTML Tag

Create a Custom HTML tag in GTM and set it to fire on **All Pages** (or your preferred trigger). Paste the following:

```html
<script>
(function(s,i,g,n,a,l){
  a=s.createElement(i);a.onload=n;a.defer=1;
  a.src="https://cdn.jsdelivr.net/gh/levelinteractive/pre-signal@"+g+"/dist/pre-signal.js";
  l=s.getElementsByTagName(i)[0];l.parentNode.insertBefore(a,l);
})(document, 'script', 'latest', function() {

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
  resolvers: {
    'gtm.linkClick': {
      'cta_click': {
        text: 'get started|sign up|request a demo',
        classes: 'btn|button|cta',
      }
    }
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

### `resolvers`

Optional. Defines site-specific rules for resolving raw GTM event names into custom event names. Each top-level key is a raw GTM event name, and each sub-key is the resolved event name. The value is a criteria object that determines when the resolution applies.

Custom resolvers run **after** the built-in auto-resolution logic. If a GTM event is already resolved by the auto-resolver (e.g. `gtm.linkClick` → `email_link_click`), custom resolvers are skipped. They only run when the event name is still the raw GTM name. First match wins — resolvers are evaluated in definition order.

When a resolver matches using a `selector` criteria, the `context.element` properties are updated to reflect the resolved node (the element matched by `closest()`) rather than the original clicked element. This is particularly useful for `gtm.click` events where GTM's event delegation gives you the leaf node (e.g. a `<span>`) instead of the meaningful interactive ancestor (e.g. the accordion header).

#### Criteria properties

| Property | Type | Description |
|---|---|---|
| `selector` | `string` | Runs `element.closest(selector)` on the GTM element. Truthy = pass. When matched, `context.element` is updated to the resolved node. |
| `text` | `string \| RegExp` | Tests against the element's text content (lowercased). Strings are compiled to case-insensitive regex. |
| `classes` | `string \| RegExp` | Tests against the element's class attribute. Strings are compiled to case-insensitive regex. |
| `match` | `'any' \| 'all'` | Defaults to `'any'`. Whether ANY or ALL provided criteria must pass. |

#### Example

```javascript
resolvers: {
  'gtm.linkClick': {
    'cta_click': {
      text: 'get started|sign up|request a demo',
      classes: 'btn|button|cta',
      match: 'any',
    }
  },
  'gtm.click': {
    'accordion_toggle': {
      selector: '[aria-expanded]',
    },
    'tab_click': {
      selector: '[role="tab"]',
    }
  }
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

- **A number** — a static score applied every time the event fires (e.g. `1`, `2.5`, `-3`).
- **A callback function** — receives a `context` object and must return a number (positive or negative).

```javascript
events: {
  // Static score
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

Returning a non-numeric value from a callback will log a warning and skip scoring for that event.

### `cookieName`

Optional. Defaults to `'_preSignal'`. The name of the session cookie used to persist the score.

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

Non-GTM events (e.g. custom `dataLayer.push({ event: 'form_submit' })`) pass through with their original name and receive a `context` object with `context.url` available. If a `gtm.*` event doesn't resolve to a named event via the built-in auto-resolver, custom [resolvers](#resolvers) are evaluated next. If no custom resolver matches either, the raw `gtm.*` event name is used to look up the scoring config — so you can still register a handler for `'gtm.linkClick'` as a catch-all for link clicks that don't match any classification.

### Link click resolution

`gtm.linkClick` events are further classified based on the link's attributes:

| Resolved Name | Condition |
|---|---|
| `email_link_click` | `mailto:` protocol |
| `phone_link_click` | `tel:` protocol |
| `outbound_link_click` | Link hostname differs from the current site's root domain |
| `file_download` | Link has a `download` attribute, or pathname ends with a known file extension (pdf, docx, xlsx, zip, mp4, etc.) |

If none of the above match, the event remains as `gtm.linkClick`. At that point, [custom resolvers](#resolvers) are evaluated if configured for `gtm.linkClick`.

### Context object

All `score` callbacks receive a `context` object. The `context.url` property (a `URL` object of the current page) is always available, regardless of event type. Additional properties depend on the event:

**`context.element`** — present for any `gtm.*` event that includes element data (e.g. `gtm.linkClick`, `gtm.click`).

| Property | Description |
|---|---|
| `context.element.node` | The DOM element (or the resolved node if a `selector`-based custom resolver matched) |
| `context.element.url` | Parsed `URL` object of the element's href, or `null` |
| `context.element.text` | The element's text content (lowercased) |
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
    event: 'form_submit',
    delta: 10,
    score: 45,
    percentile: 38,
    threshold: 'C',
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
      name: 'B',
      previous: 'C'
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
    threshold: 'D',
    events: {
      positives: 3,
      negatives: 0,
      total: 3
    }
  }
}
```

## Window CustomEvents

In addition to the dataLayer events above, PreSignal dispatches native `CustomEvent`s on the `window` object. These are useful for integrating with non-GTM code — vanilla JS, frameworks, or other scripts that need to react to scoring changes without polling the dataLayer.

You can listen for them with `window.addEventListener`:

```javascript
window.addEventListener('pre-signal:score.update', function(e) {
  console.log(e.detail);
});
```

### `pre-signal:score.update`

Fired after every scored event. The `detail` object contains:

| Property | Type | Description |
|---|---|---|
| `event` | `string` | The resolved event name that was scored |
| `delta` | `number` | The score change from this event |
| `score` | `number` | The new cumulative score |
| `percentile` | `number` | The new engagement percentile (0–100) |
| `threshold` | `string \| null` | The current threshold name, or `null` if no threshold reached |
| `events.positives` | `number` | Count of positive-scoring events |
| `events.negatives` | `number` | Count of negative-scoring events |
| `events.total` | `number` | Total scored events |

### `pre-signal:threshold.update`

Fired when a threshold boundary is crossed (in either direction). The `detail` object contains the same properties as `pre-signal:score.update`, except `threshold` is an object:

| Property | Type | Description |
|---|---|---|
| `threshold.name` | `string` | The new threshold name |
| `threshold.previous` | `string \| null` | The previous threshold name |

### `pre-signal:exclude`

Fired when a session is excluded due to a matching event in the `exclusions` config. The `detail` object contains the same properties as `pre-signal:score.update`, with `delta` always set to `0`.

## Public API

### `instance.score`

Getter that returns the current session object from the cookie.

```javascript
var session = ps.score;
// { score: 45, positives: 4, negatives: 1, total: 5, threshold: 'C', excluded: false }
```

### `instance.reset()`

Resets the session cookie to zero.

### `instance.registerEvent(eventName, score)`

Register an event after initialization. The `score` argument can be a function or a number.

```javascript
ps.registerEvent('video_complete', 5);

ps.registerEvent('scroll', function(context) {
  return context.scroll.threshold >= 90 ? 10 : 2;
});
```

### `PreSignal.version`

Static getter that returns the current library version.

```javascript
console.log(PreSignal.version); // '0.1.0-beta.1'
```