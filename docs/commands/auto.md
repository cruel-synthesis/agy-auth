# auto

Switch to the account whose quota is most at risk of going to waste.

```shell
agy-auth auto [options]
agy-auth best [options]
```

Options:

- `-n, --dry-run`: Show the ranking and the choice without switching
- `--offline`: Decide from cached quota only; make no network request
- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

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

That assumption ranks accounts; it must not pick between them. So the score
decides only when every account that can take work reported every weekly window.
Short of that, the one figure all of them did measure - their 5-hour headroom -
decides on its own: the order, the account chosen, and the margin the account in
use has to be beaten by. The ranking says which of the two it used, and leaves
out the `SCORE` column when it was not the score, since a number printed beside
an order it did not produce reads as one that was ignored. With `--json`,
`data.basis` is `weekly` or `headroom`, whether or not the account in use still
has room.

Excluded from the running:

- accounts needing a fresh sign-in, and anything that is not an OAuth account
- accounts with no current 5-hour reading, including windows whose reset has
  already passed - a lapsed window says nothing about present usage
- accounts with less than 10% of the 5-hour allowance left, which cannot carry a
  working stint however urgent their week
- accounts whose measured week is spent, until it resets
- when ranking on 5-hour headroom, accounts with less than 10% of their measured
  week left: that ranking does not weigh the week, so it would otherwise hand the
  session to an account about to hit its weekly limit. The weekly score needs no
  such rule, and still chooses a small week that is about to reset, since that is
  the quota most likely to go to waste

The account already in use has to be beaten by a clear margin, not a hair, since
a switch rewrites the Antigravity session. When it is not, the output names the
account that ranked first and says its lead was too narrow. The exception is an
account that cannot take work at all: anything that can beats it, whatever the
readings.

Exits `1` when no account can take work, and says why in terms of what is known.
Every account out of quota: when the first frees up, by the 5-hour or weekly
reset that actually frees it. Nothing read at all: the quota could not be
determined, since being unable to reach the service is not the same as finding
every account spent. Every account needing a sign-in: how to sign in again. A mix
lists how many are out of quota, not read, needing a sign-in or not OAuth, dates
only the ones out of quota, and gives only the hints that apply; an unread
account is never counted as a spent one. A refresh that failed is reported with
the refusal: on `stderr` for a person, and under `error.details.warnings` with
`--json`.
