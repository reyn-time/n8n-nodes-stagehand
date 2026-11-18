# Dependency audit follow-up

Audit snapshot: 2026-11-18, after the parser and production dependency updates for Issue 5.

The full `npm audit` reports 0 critical, 12 high, and 2 moderate vulnerabilities. Issue 5's no-critical-or-high acceptance criterion remains unmet. `npm audit --omit=dev` reports 0 vulnerabilities.

## Remaining paths

| Path | Finding | Reason it remains |
| --- | --- | --- |
| `n8n-workflow@2.49.1` → `@n8n/expression-runtime@0.40.1` → `zod@3.25.76` | High findings on `n8n-workflow`, `@n8n/expression-runtime`, and Zod | Zod 3 remains a peer of the development `n8n-workflow` dependency. The package no longer declares Zod 3 as a production dependency and uses the isolated `zod-v4` alias for Stagehand. The n8n host contract still requires Zod 3; npm only offers an `n8n-workflow@1.75.1` downgrade for its advisory. |
| `@typescript-eslint/parser@8.73.0` and `@typescript-eslint/utils@8.47.0` → `@typescript-eslint/typescript-estree`, `fast-glob`, `micromatch`, `tinyglobby`, `minimatch` | High findings on the development lint toolchain, plus moderate findings on `@typescript-eslint/utils` and `minimatch` | The parser is updated to the version npm's initial dry-run suggested. A fresh audit still flags its `tinyglobby` path and the ESLint plugin's older `utils` dependency tree. |
| `vitest@4.1.12` → `vite@6.4.6`, `fdir`, `tinyglobby`, `picomatch` | High findings in the test toolchain | npm's fix plan proposes downgrading Vite to 6.2.7 and Vitest to 3.1.4. The current Vite/Vitest versions remain until a compatible patched release or verified migration is available. |

No npm overrides were added. The production dependency tree audits clean; remaining findings come from development tooling and the n8n Zod 3 peer contract.
