# Repository instructions

## Mandatory test-instance isolation

- Never test against the live instance, including read-only browser checks or API requests.
- Always launch a separate development/test instance on a verified free port using the most current code in this project, including current working-tree changes. Rebuild its client assets after relevant changes before browser verification.
- Give the dev instance its own disposable data directory, database, configuration, and synthetic test credentials. Never reuse or copy live data, credentials, sessions, or connected production nodes/integrations.
- Bind dev listeners to loopback and verify the browser origin, API/proxy destination, and data paths before any test. Do not assume an existing localhost server is a dev instance.
- Keep node and integration tests within isolated local fixtures. Prevent test workers and integrations from contacting the live instance or production services.
- Record the dev instance's port, process, and data directory. Stop only test processes created for the task; never restart, reconfigure, or stop the live instance.

## Development workflow

- Develop test-first. Cover new functions and classes where practical, including meaningful branches and edge cases.
- Read a file before editing it and find all callers before modifying a function. Prefer Token Savior MCP navigation when available, otherwise use ripgrep.
- Keep changes focused and use the simplest solution appropriate to the problem. Surface unrelated design issues separately.
- Ask when intent, architecture, or requirements are unclear. When unattended, choose the most reasonable interpretation and record it. State uncertainty explicitly.
- Use named constants or variables instead of magic numbers.
- Run all tests before committing. Commit changes with a descriptive message, but never push unless explicitly requested.
- Never stage or commit implementation plans or planning documents unless explicitly asked to commit that specific document. Keep them local and untracked.
- Do not use preview to check changes unless specifically requested.
- Prefer the lowest-cost available model that can reliably complete the work; use GPT-5.3-Codex-Spark for suitable simple tasks when available.
- Keep responses as short as possible without omitting necessary information.
