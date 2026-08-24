# switch

```shell
agy-auth switch [selector] [-j, --json]
agy-auth -
```

A selector may be a `list` row number, alias, email, exact account ID, or account ID prefix of at least four characters. Email and alias selectors may be substrings. Without a selector, an interactive terminal opens the profile picker. `agy-auth -` and `agy-auth switch -` select the previous profile.

`switch` **never makes a network request**. It renders the same seven-column plan and quota table as `list`, from cached data only, so switching stays fast. To refresh those numbers, run `agy-auth list` or `agy-auth current`.

Selection validates credentials and external paths before writing. Existing settings, service-account files, and ADC destinations are backed up, and caught failures are rolled back. JSON output removes credentials and tells callers whether `agy-auth env` is needed.

API-key and service-account variables cannot be injected into the parent shell. Apply them after selection:

```shell
eval "$(agy-auth env)"
```
