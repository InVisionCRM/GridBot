# Live stream v2 (`GET /api/bot/stream?v=2`)

Server-sent events. v1 (no `?v`) is unchanged: it sends the whole status about once a second. v2 sends the status once, then only what changed.

Code:
- server: `src/server/statusFeed.ts`, wired up in `src/server/app.ts`
- diff and apply, shared by server and client: `src/live/delta.ts`
- client: `src/ui/useStream.ts`
- tests: `tests/streamV2.test.ts`

## Events

| event | when | data |
|---|---|---|
| `hello` | first, on every connect | `{ v: 2, t, network, epoch, seq, status, recent, hbMs }` |
| `patch` | the status changed (at most once per throttle window, default 1 s) | `{ seq, t, ops }` |
| `hb` | every `hbMs` (default 5 s) | `{ t, seq, epoch }` |
| `activity` | each activity event; its SSE `id:` is the event id, as in v1 | `ActivityEvent` |
| `ticks` | each poll's price batch, as in v1 | `{ t, prices }` |

Fields:
- `epoch`: random per server process. If it changes, the server restarted.
- `seq`: the status version. `hello.seq` is the version of `hello.status`. Each `patch` has `seq = previous + 1`. `hb.seq` is the newest version sent.
- `status`: the same object `GET /api/bot/status` returns, as JSON (keys whose value is `undefined` are absent).
- `recent`: activity events newer than `Last-Event-ID`, or `?since=` (up to 100).
- `t`: server time, in ms.

## Ops

A path is a list of keys and array indexes from the root of `status`. Ops are applied in order.

| op | meaning |
|---|---|
| `['s', path, value]` | set: replace the value at `path` (`[]` = the whole status) |
| `['d', path]` | delete the key at `path` |
| `['a', path, items, drop]` | array at `path`: remove `drop` items from the front, then append `items` (rolling histories such as equity points) |
| `['p', path, items, keep]` | array at `path`: keep its first `keep` items and put `items` in front (newest-first lists such as trades) |

`apply()` copies only the objects and arrays along each path, so React sees new references exactly where something changed.

## Client rules
1. On `hello`: set the status to `hello.status` and remember `seq` and `epoch`.
2. On `patch`: if `patch.seq !== seq + 1`, **resync**. Otherwise apply the ops and set `seq = patch.seq`.
3. On `hb`: if `hb.epoch !== epoch`, or `hb.seq < seq`, **resync**.
4. **Resync** = close the EventSource and open a new one. The new `hello` is a full snapshot. No separate snapshot endpoint is needed: SSE is ordered on one connection, so a gap means the client missed something across a reconnect.
5. **Stale:** if nothing at all (patch, hb, activity, ticks) arrives for `3 × hbMs`, show "No update from the bot server for a while" until something arrives. While the client has fallen back to polling (EventSource error), its own error line applies instead.

## Server rules
- The status is computed **once per push** for all clients. v1 clients get it whole; v2 clients get the diff against the previous push. Before this change, each open stream computed and sent its own full status every second.
- No change means no `patch`. The `hb` keeps the connection and staleness check alive.
- With no client connected, the feed doesn't listen. The next client's `hello` takes a fresh snapshot and bumps `seq`.

## Size
A grid's status carries up to 100 trades and up to 600 equity points. When one point is added at the cap, v1 sends the whole status again; v2 sends one `['a', [...,'equityHist'], [[t,v]], 1]`. The test `delta ops` checks that a 600-point roll plus a few edits costs under 1/20 of the full object.
