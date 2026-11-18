# @dndr/n8n-nodes-stagehand

Community nodes for browser automation with [Stagehand](https://github.com/browserbase/stagehand), Playwright, and Chrome DevTools Protocol (CDP).

## Install

Install `@dndr/n8n-nodes-stagehand` in your n8n community nodes environment, then restart n8n. The Stagehand node requires a reachable Chromium CDP WebSocket URL and a connected n8n Chat Model. The selected Chat Model owns its provider, credentials, endpoint, and model configuration.

Stagehand 4.4 requires Node.js 22.18 or newer and Chrome 137 or newer. Stagehand v4 moved its runtime into a browser extension. That extension must be available to the browser. When the browser runs in a separate machine or container, install the extension there first; a CDP connection cannot make files on the n8n host available to Chromium. See the [Home Assistant OS VNC Web Browser setup](docs/home-assistant-vnc-web-browser.md) for one common configuration. The Playwright node continues to connect directly with Playwright's `connectOverCDP` API and does not need the Stagehand extension.

Connect a Chat Model node to Stagehand's **Model** input. Configure **Maximum Output Tokens** under Advanced Options if needed; it defaults to 4096. Stagehand supports **Act**, **Extract**, and **Observe**. Extract also needs an output schema.

## Manual integration check: OpenRouter and a remote browser

These checks exercise the configured OpenRouter model without changing the browser lifecycle. Use a non-production browser session and a model that supports structured output for Extract.

1. Configure an n8n OpenRouter Chat Model with your OpenRouter credentials and select a model. Connect it to the Stagehand node's **Model** input. Keep the CDP browser endpoint reachable from the n8n host.
2. Add a Playwright node using that same CDP URL. Run its **Goto** operation with `https://example.com` and confirm the browser reaches the Example Domain page.
3. Run Stagehand **Extract** against the same CDP URL. Choose **Example JSON** and use `{"title":"Example Domain"}` as the example. Confirm the result contains the page title.
4. Use the Playwright node's **Goto** operation to navigate the browser to `https://en.wikipedia.org/wiki/Playwright`. Run Stagehand **Act** with an instruction such as `click the first link in the article`. Confirm the browser navigates and the operation succeeds.
5. Run Stagehand **Observe** with an instruction such as `find the article's first link`. Confirm it returns an observation describing a matching element.
6. Open the [OpenRouter Activity page](https://openrouter.ai/activity) and inspect the requests produced by these runs. Verify the actual model shown for each request matches the model selected in the connected n8n Chat Model, including any configured provider routing. Do not rely only on the node's display name.

## Development

Development installs and checks require Node.js 24 or newer. The published node runtime requires Node.js 22.18 or newer for Stagehand.

```sh
npm install
npm run build
npm test
npm pack --dry-run
```

Tests use mocked Stagehand and Chat Model implementations; they do not make paid model requests.

## License

MIT. See [LICENSE.md](LICENSE.md).
