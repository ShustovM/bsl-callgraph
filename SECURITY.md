# Security policy

## Supported versions

Security fixes are provided for the latest release and the current default
branch. Older releases may be asked to upgrade before a fix is prepared.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** form in the repository's
Security tab. Include the affected version, operating system, Node.js version,
reproduction steps, expected impact, and any suggested mitigation.

If private reporting is temporarily unavailable, open a public issue containing
only a request for a private maintainer contact channel. Do not include secrets,
proprietary BSL source, or undisclosed vulnerability details in that issue.

Maintainers aim to acknowledge a complete report within seven calendar days.
Disclosure timing will be coordinated with the reporter after impact and a fix
path are understood.

## Security and privacy boundary

The server is designed to read `.bsl` files beneath the configured root. It
does not need network access or execute BSL code. Treat unexpected file writes,
process execution, access outside the configured root, unsafe link traversal,
or unbounded disclosure as security issues.

Source parsing happens locally, but tool results can contain symbol names,
module names, canonical module IDs, relative file paths, and source line
locations. Those results are visible to the connected MCP client and may be
sent onward according to that client's privacy policy. The configured absolute
root remains local to the server's launch configuration and is not returned by
tools. Review the client's data handling before indexing confidential
repositories.
