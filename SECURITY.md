# Security Policy

## Supported Scope

Security reports are welcome for the actively maintained parts of this repository:

- frontend/
- backend/
- docker-compose.yml
- root environment templates and contributor tooling

The following areas are currently not under active development and are out of normal support scope unless a change is explicitly requested:

- android/
- twa/

## Reporting a Vulnerability

Please do not open a public GitHub issue for a suspected vulnerability.

Instead:

1. Open a private GitHub security advisory if the repository has private reporting enabled.
2. If private reporting is not available, contact the maintainer on GitHub at @aman1117 and share the details privately first.

Include the following information when possible:

- A clear description of the issue.
- Steps to reproduce.
- The affected area or file path.
- Impact assessment.
- Suggested mitigation if you have one.

## Response Expectations

The maintainer will try to:

- Acknowledge receipt within 7 days.
- Confirm severity and scope as quickly as practical.
- Provide a remediation plan or status update once the issue is understood.

## Disclosure

Please allow time for a fix before public disclosure. Coordinated disclosure helps protect users and contributors.

## Secrets Hygiene

If you believe a credential or secret was committed at any point in repository history, treat it as compromised and rotate it immediately.
