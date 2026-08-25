# LionLog iPhone PWA verification

Use this checklist against the private production URL after the exact merged commit is deployed.

## Required device pass

- Open the private URL in Safari on an iPhone and complete the required sign-in.
- Confirm the sample-data label is visible and the meal-builder controls work.
- Choose **Share → Add to Home Screen**, accept the LionLog name, and launch the new icon.
- Confirm LionLog opens without Safari chrome in standalone mode and respects the safe areas.
- Close and relaunch the installed app; confirm the authenticated session still works.
- Turn on airplane mode, fully close LionLog, then reopen it from the home screen.
- Confirm the core interface and sample menu load, and the offline status bar is visible.
- Restore connectivity and confirm the offline status bar clears without losing the current interface.
- After a later deployment, reopen LionLog, tap **Update LionLog** if prompted, and confirm the refreshed app still loads.

## Evidence record

- Build/commit tested:
- iPhone model and iOS version:
- Private sign-in: pending device test
- Add to Home Screen / standalone: pending device test
- Offline cold reopen: pending device test
- Authentication persistence: pending device test
- Update activation: pending deployment test
- Notes:

Desktop mobile-viewport and service-worker checks are useful preflight evidence, but they do not replace this physical-device pass.

## Alpha.2 local preflight — 2026-08-25

- Production build rendered at a 375 CSS-pixel phone viewport with no console warnings or errors.
- Relative manifest, Apple touch icon, and theme metadata were present in the rendered page.
- A clean-origin service worker installed, and the page was reloaded once to establish control.
- After the local server process was stopped, a fresh navigation still returned the LionLog title, core meal-builder interface, and sample menu from the offline shell.
- Automated build, lint, domain tests, rendered-HTML tests, manifest tests, icon-dimension tests, and service-worker contract tests passed.
