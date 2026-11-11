# Cloudflare source assessment and license

Inspected [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)
at commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` on 2 November 2026.
The source, not popularity or benchmark claims, informs this adaptation:

- [Skill and execution boundaries](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/SKILL.md)
- [Reconnaissance and coverage](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/RECONNAISSANCE.md)
- [Hunting and candidate gates](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/HUNTING.md)
- [Validation and reporting](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/VALIDATION-AND-REPORTING.md)
- [Attack-class selection](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/ATTACK-CLASSES.md)
- [Finding schema](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/report-schema.json)
- [MIT license](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/LICENSE)

## Adaptation within existing owners

| Source method | Local application |
| --- | --- |
| Source-derived coverage units and prior-run gaps | A compact coverage map in Engineering Review's existing report/cycle note, tied to changed surfaces and actual checks. |
| Trace the principal, boundary, strongest control and effect; try to disprove candidates | Conditional security probes in the existing checklist and security guide. |
| Separate confirmed, needs_validation and rejected records | Existing actionable findings use supported evidence; unresolved leads get exact blockers without severity; material rejections retain counterevidence. |
| Independent validation and final-record verification | The caller's existing independent review and final-candidate checks, within its current pass budget. |
| Source-derived fingerprints and additive coverage | Stable root-cause/path identities, current-source rechecks, and visible gaps on resume. |
| Bounded local execution and target-neutral evidence | Synthetic inputs, verified confinement for security reproductions, minimum demonstrated effect, and explicit static/runtime evidence limits. |

Our existing review contract permits decisive static proof. Upstream's confirmed
schema requires a local observed result; we therefore do not claim schema
compatibility or relabel static proof as an upstream confirmation. A new JSON
schema/validator would duplicate the current report and delivery-note owners.

The full audit pipeline, multi-wave agents, per-candidate and replacement
verifiers, run directories, profiles, JSON ledgers, validators and
domain companion files are not bundled. Their responsibilities exceed a scoped
diff review or would conflict with ADR-0005's two-pass budget. Boundary-based probe
selection borrows their method without claiming their complete domain coverage.
No upstream executable, installer or target audit was run. Package checks and
authored scenarios establish distribution and instruction consistency, not better
vulnerability discovery, fresh-agent adherence or production security.

## Upstream MIT notice

MIT License

Copyright (c) 2025-2026 Cloudflare, Inc.

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
