# PSU live-menu architecture audit

This directory is the `v0.2.0-alpha.1` research and architecture milestone. It does not implement or deploy a live provider.

Authorization update: in August 2026, Penn State Residential Dining approved LionLog's use of publicly available dining-menu information. This approval did not grant access to an official or private API. The dated audit findings remain below as the history that informed the architecture.

- [Official source audit](source-audit.md)
- [ADR 001: same-origin public-menu adapter](adr-001-access-method.md)
- [Source-to-domain field mapping](field-mapping.md)
- [Caching, validation, attribution, and failure policy](operating-policy.md)
- [Custom-domain readiness](custom-domain-readiness.md)
- [Deployment and Admin handoff](deployment-handoff.md)
- [`v0.2.0-alpha.2` implementation notes](implementation-alpha-2.md)
- [`v0.2.0-alpha.2` verification report](verification-alpha-2.md)

The representative fixture at `tests/fixtures/psu/sanitized-menu-observation.v1.json` contains parsed plain text and numeric observations only. No upstream HTML is stored or rendered.
