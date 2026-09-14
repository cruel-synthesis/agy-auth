# auto

Switch to the account whose quota is most at risk of going to waste.

```shell
agy-auth auto [options]
agy-auth best [options]
```

Options:

- `-n, --dry-run`: Show the ranking and the choice without switching
- `--offline`: Decide from cached quota only; make no network request (default: false)
- `-j, --json`: Output results as JSON
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

Excluded from the running:

- accounts needing a fresh sign-in, and anything that is not an OAuth account
- accounts with no current reading, including windows whose reset has already
  passed - a lapsed window says nothing about present usage and is never assumed
  to be full
- accounts with less than 10% of the 5-hour allowance left, which cannot carry a
  working stint however urgent their week

The account already in use has to be beaten by a clear margin, not a hair, since
a switch rewrites the Antigravity session.

Exits `1` when no account can take work, naming when the first one frees up.
