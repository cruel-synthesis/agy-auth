# Third-Party Software Notices and Information

This project references the following MIT-licensed projects. The notes identify what was adapted or used as a design reference, followed by each license text.

---

## 1. ag-multi-account-switchboard

- **Source**: `https://github.com/erennyuksell/ag-multi-account-switchboard`
- **Reference Commit**: `1cbe6abcb17321c5e945962c9eeb710604d3b9d4`
- **License**: MIT License
- **Nature of use**: The Antigravity Cloud Code endpoint set and host-fallback order used by `src/core/quota.ts`, and the `loadCodeAssist` plan/project-discovery step, were derived from this project. The implementation is independent: `agy-auth` never substitutes a default project ID, ships no OAuth client ID or client secret, enforces a bounded per-account deadline, validates payload shapes strictly, and treats an unrecognized response as a failure rather than as zero quota.

### MIT License Text
```text
MIT License

Copyright (c) 2025 Eren

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. codex-auth

- **Source**: `https://github.com/loongphy/codex-auth`
- **Reference Commit**: `0fde29598c2e02e28e0e8bcc33a4bb8d45d7b23a`
- **License**: MIT License
- **Nature of use**: Concepts referenced for the account table layout, cached-usage timestamps, bounded refresh concurrency, and merging server-derived state into a local registry. `agy-auth` differs on staleness: an elapsed window renders as `stale` rather than as `100%`.

### MIT License Text
```text
MIT License

Copyright (c) 2026-PRESENT Loongphy<https://github.com/loongphy>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
