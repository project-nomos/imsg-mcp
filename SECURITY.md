# Security policy

`imsg-mcp` gives an AI assistant access to someone's private messages and the ability to text from their number. We take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead, use GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within 3 business days and to ship a fix or mitigation for confirmed issues within 30 days, and we will credit you in the release notes if you wish.

## In scope

- Bypassing authentication or the Access JWT check at the origin.
- Sending a message that the send rules (role, allowlist, length, rate limit) should have refused.
- Reading chats outside `read.scope`, or message text reaching logs other than the audit log's record of sends.
- Escalating from the bot user to the permissions held by the signed binary, or from a `read` token to sending.
- Anything that weakens the guarantees described in [docs/security.md](docs/security.md).

## Out of scope

- A model being persuaded by message text to _ask_ to send something. That is the known prompt-injection risk the design contains with approval prompts, the allowlist and the rate limit; it is described in [docs/security.md](docs/security.md). A way to make the _server_ send without passing the rules is in scope.
- Vulnerabilities in `imsg`, Cloudflare, macOS or Claude clients. Please report those to their maintainers (for `imsg`: https://github.com/steipete/imsg).

## Supported versions

Security fixes go into the latest release.
