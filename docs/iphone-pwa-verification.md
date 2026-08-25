# LionLog iPhone PWA verification

Use this checklist against the public production URL after the exact merged commit is deployed.

## Required device pass

- Open the public URL in Safari on an iPhone and confirm LionLog appears directly without any sign-in screen.
- Confirm the sample-data label is visible and the meal-builder controls work.
- Choose **Share → Add to Home Screen**, accept the LionLog name, and launch the new icon.
- Confirm LionLog opens without Safari chrome in standalone mode and respects the safe areas.
- Close and relaunch the installed app; confirm it returns directly to LionLog without any sign-in screen.
- Turn on airplane mode, fully close LionLog, then reopen it from the home screen.
- Confirm the core interface and sample menu load, and the offline status bar is visible.
- Restore connectivity and confirm the offline status bar clears without losing the current interface.
- After a later deployment, reopen LionLog, tap **Update LionLog** if prompted, and confirm the refreshed app still loads.

## Evidence record

- Build/commit tested:
- iPhone model and iOS version:
- Anonymous direct launch: pending device test
- Add to Home Screen / standalone: pending device test
- Offline cold reopen: pending device test
- Relaunch without sign-in: pending device test
- Update activation: pending deployment test
- Notes:

Desktop mobile-viewport and service-worker checks are useful preflight evidence, but they do not replace this physical-device pass.

## Alpha.2.1 field-test preflight — 2026-08-25

- Exact merged commit: recorded in the release report after squash merge.
- Public direct access: an unauthenticated HTTPS request returned `200` at the unchanged production URL with no redirect, rendered the LionLog title/headline/sample menu, and exposed no visible sign-in prompt.
- Production build rendered at a 375 × 812 CSS-pixel viewport with no horizontal overflow or console warnings/errors.
- Alpha.2 to Alpha.2.1 update: on a clean isolated origin, Alpha.2 installed and controlled the page; after the build changed, the **Update LionLog** action appeared and activated Alpha.2.1 without console errors.
- Offline cold launch: after Alpha.2.1 activation and server shutdown, a fresh navigation rendered the Alpha.2.1 marker, headline, sample label, and all six sample menu rows from the offline shell.
- Physical iPhone Safari, Add to Home Screen, standalone/safe-area, relaunch, offline, and update checks remain pending.

## Alpha.2 local preflight — 2026-08-25

- Production build rendered at a 375 CSS-pixel phone viewport with no console warnings or errors.
- Relative manifest, Apple touch icon, and theme metadata were present in the rendered page.
- A clean-origin service worker installed, and the page was reloaded once to establish control.
- After the local server process was stopped, a fresh navigation still returned the LionLog title, core meal-builder interface, and sample menu from the offline shell.
- Automated build, lint, domain tests, rendered-HTML tests, manifest tests, icon-dimension tests, and service-worker contract tests passed.
