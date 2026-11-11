# Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/iboss21/shared-table.git
cd shared-table
npm test          # mock agents, no model requests
npm run demo      # scripted agents, no accounts needed
```

- No runtime dependencies. Please keep it that way: Node built-ins on the server, plain JavaScript and CSS in the browser.
- Add a test for every behaviour change. Tests must not call a real model.
- New agent adapters go in `src/agents.mjs`. State in the pull request which CLI version you tested against, and mark anything you could not run as not tested.
- Screenshots and the demo video are regenerated with `node scripts/capture.mjs` (needs Google Chrome).

By contributing you agree that your contribution is released under the MIT License.
