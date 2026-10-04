# switch

Switch to a saved account (makes no network request).

```shell
agy-auth switch [options] [query]
agy-auth sw [options] [query]
agy-auth -
```

Arguments:

- `query`: Account selector (number, alias, email, ID, or `-` for previous active account)

Options:

- `-j, --json`: Output as JSON
- `-h, --help`: Show this help

A switch replaces Antigravity's signed-in session. In Antigravity's settings it
writes only the account's own Google Cloud project and location, and a model if
one was saved with `model set`; every other setting stays as it is and is shared
by all accounts.

Switching to an account that needs a sign-in still goes ahead, with a warning
that says how to renew it.

On Linux and Windows, agy-auth can update only Antigravity's token file, not the
system keyring, so switching to a Google sign-in account warns that Antigravity
may stay on the previous account.
