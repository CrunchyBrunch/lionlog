# PSU live-menu architecture audit

This directory is the `v0.2.0-alpha.1` research and architecture milestone. It does not implement or deploy a live provider.

- [Official source audit](source-audit.md)
- [ADR 001: permission-gated same-origin adapter](adr-001-access-method.md)
- [Source-to-domain field mapping](field-mapping.md)
- [Caching, validation, attribution, and failure policy](operating-policy.md)
- [Custom-domain readiness](custom-domain-readiness.md)
- [Deployment and Admin handoff](deployment-handoff.md)

The representative fixture at `tests/fixtures/psu/sanitized-menu-observation.v1.json` contains parsed plain text and numeric observations only. No upstream HTML is stored or rendered.
