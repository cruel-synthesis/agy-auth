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

- `-j, --json`: Machine-readable output
- `-h, --help`: Show this help

Switching to an account that needs a sign-in still goes ahead, with a warning
that says how to renew it.
