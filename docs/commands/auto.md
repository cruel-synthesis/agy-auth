# auto

Switch to the account whose quota is most at risk of going to waste.

```shell
agy-auth auto [options]
agy-auth best [options]
```

Options:

- `-n, --dry-run`: Show the ranking and the choice without switching
- `-w, --watch`: Keep running and switch whenever the account in use runs out
- `--interval <minutes>`: Minutes between checks while watching (default: 5)
- `--offline`: Decide from cached quota only; make no network request (default: false)
- `-j, --json`: Output results as JSON
- `-h, --help`: Show this help

## Switching on its own

`agy-auth auto --watch` stays running and takes a live reading of the account in
use every few minutes. While that account still has room it does nothing but say
so. The moment it runs out, the others are read and the best one is switched to,
by the same scoring described below.

```
  Watching the account in use, switching when it runs out. Checking every 5 min.
  Ctrl-C to stop.

  14:32  work@example.com has 62% of its 5-hour limit left
  14:37  work@example.com has 18% of its 5-hour limit left
  14:42  work@example.com: 5-hour limit nearly spent; switched to spare@example.com
  14:47  spare@example.com has 94% of its 5-hour limit left
```

A check that cannot reach the service changes nothing: the watcher keeps the
account in use rather than moving off it because the network failed. A rejected
credential is different - the answer is decisive, so the watcher treats the
account as spent and looks for another.

Only the account in use is contacted on an ordinary check, so leaving the watcher
running costs one account's traffic per interval rather than everyone's. With
`--json` each check prints one JSON object per line. With `--dry-run` it reports
what it would do and switches nothing. It cannot be combined with `--offline`.

This is a process you start and can see, not a service installed behind your back:
closing the terminal ends it. Antigravity picks up the switched session the same
way it does after `agy-auth switch`.

## How the choice is made

Quota is spent through two allowances at once. The 5-hour allowance caps how much
work an account can take before its next reset. The weekly allowance is the one
that can actually be lost: whatever is left in it when the week resets is gone.

Each account is scored on both. The weekly share still unspent is divided by the
number of 5-hour windows left before it resets, giving the share that would have
to be spent per window for none of it to be wasted. That pressure rises as the
reset approaches, which is why an account with a week expiring tomorrow is
preferred over an equally full one expiring in three days - the later one can
still be spent later. Multiplying by the 5-hour allowance left keeps the choice on
an account that can actually take work now. Both model families are scored and
averaged.

A family whose weekly window reported nothing, or whose weekly reset has already
passed, is scored as an untouched week: below anything visibly about to expire
and above anything visibly spent. The ranking shows `-` rather than a percentage
there, because nothing was measured.

That assumption ranks accounts, but it never moves you between them. A switch
needs the two accounts to be comparable on readings: either every family on both
sides reported its weekly window, or no family on either side did. When no family
reported one, the same assumption enters both scores the same way and measured
5-hour headroom decides. An account whose score mixes measured and assumed weeks
can still win the ranking and still be reported as the better use of your quota,
but the session is not rewritten on it. `--dry-run` shows the ranking either way.

Excluded from the running:

- accounts needing a fresh sign-in, and anything that is not an OAuth account
- accounts with no current 5-hour reading, including windows whose reset has
  already passed - a lapsed window says nothing about present usage
- accounts with less than 10% of the 5-hour allowance left, which cannot carry a
  working stint however urgent their week

The account already in use has to be beaten by a clear margin, not a hair, since
a switch rewrites the Antigravity session. The exception is an account that
cannot take work at all: anything that can beats it, whatever the readings.

Exits `1` when no account can take work. It names when the first one frees up if
a reading says so, and says the quota could not be determined when nothing could
be read at all - being unable to reach the service is not the same as finding
every account spent. A refresh that failed is reported with the refusal: on
`stderr` for a person, and under `error.details.warnings` with `--json`.
