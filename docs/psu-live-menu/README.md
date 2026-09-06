# PSU live-menu architecture audit

This directory contains the dated `v0.2.0-alpha.1` research record plus the implemented Alpha 2 ingestion, Alpha 3 cached-delivery, and Alpha 4 field-release preparation reports. The Alpha 1 documents preserve the uncertainty and proposed architecture that existed at that time.

Authorization update: in August 2026, Penn State Residential Dining approved LionLog's use of publicly available dining-menu information. This approval did not grant access to an official or private API. The dated audit findings remain below as the history that informed the architecture.

- [Official source audit](source-audit.md)
- [ADR 001: same-origin public-menu adapter](adr-001-access-method.md)
- [Source-to-domain field mapping](field-mapping.md)
- [Caching, validation, attribution, and failure policy](operating-policy.md)
- [Custom-domain readiness](custom-domain-readiness.md)
- [Deployment and Admin handoff](deployment-handoff.md)
- [`v0.2.0-alpha.2` implementation notes](implementation-alpha-2.md)
- [`v0.2.0-alpha.2` verification report](verification-alpha-2.md)
- [`v0.2.0-alpha.3` cached-delivery implementation](implementation-alpha-3.md)
- [`v0.2.0-alpha.3` verification report](verification-alpha-3.md)
- [`v0.2.0-alpha.4` field-release preparation](implementation-alpha-4.md)

Committed HTML fixtures are explicitly sanitized and deterministic. The representative JSON fixture at `tests/fixtures/psu/sanitized-menu-observation.v1.json` contains parsed plain text and numeric observations only. No raw upstream HTML is stored or rendered.
