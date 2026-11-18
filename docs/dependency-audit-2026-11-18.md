# Dependency audit follow-up

Audit snapshot: 2026-11-18, after the dependency refresh for Issue 5.

`npm audit` reports 0 critical, 11 high, and 3 moderate vulnerabilities. Issue 5's no-critical-or-high acceptance criterion remains unmet.

## Remaining paths

| Path | Finding | Reason it remains |
| --- | --- | --- |
| `n8n-workflow@2.49.1` → `@n8n/expression-runtime@0.40.1` → `zod@3.25.76` | High findings on `n8n-workflow`, `@n8n/expression-runtime`, and Zod | The n8n peer currently requires Zod 3.25.76. Stagehand 4.4.0 requires Zod 4.6.6. The package keeps both versions isolated; changing the n8n peer to Zod 4 or downgrading the host API would break the supported n8n contract. npm only offers an `n8n-workflow@1.75.1` downgrade for its advisory. |
| `@typescript-eslint/parser@8.47.0` → `@typescript-eslint/typescript-estree` → `fast-glob`, `micromatch`, `minimatch` | High findings on the parser's development toolchain | These packages are used by the required n8n ESLint plugin. npm's current advisory data identifies conflicting affected ranges across parser releases, so no compatible parser update has been selected. |
| `vitest@4.1.12` → `vite@6.4.6`, `fdir`, `tinyglobby`, `picomatch` | High findings in the test toolchain | npm's current audit data still marks these paths after moving off the vulnerable Vitest 3 line and selecting the compatible Vite 6 patch line. |

No npm overrides were added. Stagehand's Zod 4 dependency is also installed under the explicit `zod-v4` alias so n8n can continue resolving its Zod 3 peer independently.
