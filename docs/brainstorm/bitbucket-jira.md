# Bitbucket and Jira integration

Brainstorm input for a future `/speckit-specify`. Not a spec or plan. Nothing here is decided.

## 1. Goal and constraints

Goal: let a user work with Bitbucket pull requests and Jira issues from Arbareto. Ordinary Git work must stay the same without them.

Each integration is optional. Each integration is off by default. The user turns it on for each host.

An integration may:

- call a host REST API through new bounded, typed service operations;
- open a URL in the system browser;
- read a credential that the user stored for that host;
- write a Jira key into a commit message or a branch name when the user picks the issue.

An integration may not:

- make any Git operation depend on a network service or a cloud account (constitution, "local-first");
- give the renderer a raw HTTP client, a shell, or free-form URLs (constitution: bounded, typed operations);
- run code that a repository supplies, or trust a host URL that comes from repository config without a user approval (constitution V);
- decide by message text, branch-name patterns, or error-message text (CLAUDE.md "No heuristics");
- write a token, an Authorization header, or URL user information to a log (constitution V). The service already redacts URL user information, see `src/contracts/envelope.ts:463`.

## 2. Questions for the user

- Bitbucket Cloud (bitbucket.org), or Bitbucket Data Center / Server? Both? The APIs and the auth are different.
- Jira Cloud, or Jira Data Center? The auth is different.
- Is there a company proxy? Is there an internal certificate authority (TLS inspection)?
- Does the company use SSO? Does SSO block API tokens or personal access tokens?
- Do you already use Git Credential Manager (GCM) for Bitbucket over HTTPS? Or SSH keys?
- Which features matter most? Pick the top three from section 4.
- Do you want only links into the browser, or real data in the app?

## 3. Approach options

### (A) A general third-party plugin system

It would need:

- a sandbox for plugin code (a separate process or a worker with no file system and no process access);
- a permission model (network hosts, credential access, repository read) and a consent UI;
- a versioned plugin API with a compatibility policy;
- UI extension points in the renderer (menu items, panels, branch-label badges) that cannot inject markup;
- distribution: install, update, signatures, and a trust decision per plugin.

Why it is hard here:

- The service is one compiled Bun binary. Loading third-party JavaScript into it gives the plugin all service rights. Bun has no permission sandbox like Deno (unverified for the current Bun release).
- Plugin UI in a WebView must not get the Tauri IPC bridge. That needs an iframe or a separate webview with its own capability set.
- The brief rejects "generic plugin platforms ... without a concrete requirement" (`docs/project-brief.md:105`). Two Atlassian products are not yet that requirement.
- Each extension point becomes a public contract. That freezes internal contracts early.

### (B) First-party integration modules behind the existing contracts

- Service: one module per host family (`bitbucket-cloud`, `bitbucket-dc`, `jira-cloud`, `jira-dc`). Each module uses `fetch` with a bounded body size, a timeout, and cancellation.
- Contracts: new typed operations, for example `pr.createLink`, `pr.listForBranch`, `jira.searchIssues`, `jira.getIssue`. Each operation returns typed results or a typed error.
- Shell: stores tokens in the OS credential store (Windows Credential Manager first). The shell gives the token only to the service, never to the renderer.
- Renderer: panels and menu items that call the typed operations. No raw HTTP.
- Config: a host record per integration (base URL, product, enabled flag). The user creates it. A remote URL alone never creates it.

### (C) Open in the browser only

- Example: a branch context-menu item "Create pull request" opens the host's create-PR page for that branch.
- Example: a Jira key that the user stored for a branch opens `https://<jira>/browse/<KEY>`.
- No API calls. No credentials. No network code in the service.
- The URL comes from a host record that the user approved, plus exact values from Git (remote URL parse, branch ref).
- Bitbucket Cloud create-PR URL form `https://bitbucket.org/<workspace>/<repo>/pull-requests/new?source=<branch>` is unverified. Confirm it before use.

### Comparison

| Option | Effort | Security risk | Fit with architecture |
|---|---|---|---|
| A. Plugin system | XL | High: third-party code, new trust surface, UI injection | Poor. The brief rejects generic plugin platforms. |
| B. First-party modules | M to L | Medium: tokens and network, but our own code | Good. Same pattern as the Git operations. |
| C. Browser only | S | Low: no tokens, only URL building | Good. Very thin. |

Proposal: start with C. Add B for the two or three features that need data (PR status on branches, Jira issue pick). Do not build A. Revisit A only when a third concrete integration needs it.

## 4. Feature candidates

| Feature | Value | Effort | Needs API | Needs credentials | Needs network |
|---|---|---|---|---|---|
| Bitbucket: open PR for the branch in the browser | High | S | No (C) | No | Browser only |
| Bitbucket: create PR from a branch (in-app dialog) | High | M | Yes | Yes | Yes |
| Bitbucket: PR state and reviewers on branch labels | High | M | Yes | Yes | Yes, polled or on demand |
| Bitbucket: build status for a commit | Medium | M | Yes | Yes | Yes |
| Bitbucket: read review comments | Medium | L | Yes | Yes | Yes |
| Jira: pick an issue for a new branch name or a commit message | High | M | Yes (search) | Yes | Yes |
| Jira: show issue status for a linked key | Medium | S after the pick | Yes | Yes | Yes |
| Jira: open the issue in the browser | Medium | S | No (C) | No | Browser only |
| Jira: transition an issue (optional, with confirmation) | Low | M | Yes | Yes, write scope | Yes |

## 5. Linking Jira keys without heuristics

The rule forbids a regex like `[A-Z]+-\d+` over messages or branch names. Options:

| Option | How it works | Keeps the rule? |
|---|---|---|
| Explicit pick plus template | The user picks an issue from a Jira search. Arbareto writes the key through a user template, for example `{key}: {summary}` or `feature/{key}-{slug}`. The key comes from the API response. | Yes. The source is a typed API value and a user action. |
| Explicit link record | Arbareto stores `{branch ref or commit id -> issue key}` in its own local store (or in `git config branch.<name>.jiraKey`, unverified as a convention). Display reads only that record. | Yes. The record is a contract-defined value. |
| Display-only links from text | Arbareto scans messages for key-like text and shows links. | No. It classifies by message text. Reject it. |
| Git trailer | The template writes a trailer, for example `Jira: ABC-123`. Arbareto reads it with `git interpret-trailers --parse` or `%(trailers:key=Jira)`. | Yes, if only that exact trailer key is read. The trailer is a Git-defined machine format. |

Proposal: explicit pick plus template for writing. Link record or exact trailer for reading.

## 6. Credentials and network

### Auth per product

| Product | Methods | Notes | Source |
|---|---|---|---|
| Bitbucket Cloud | API tokens (scoped), OAuth 2.0 | App passwords: no new ones since 2025-09-09. Brownouts from 2026-06-09. Full removal 2026-07-28 (per community notice). API calls use the account email; Git over HTTPS uses the username. | https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-transitions-to-api-tokens-enhancing-security-with-app-password-deprecation ; https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-enters-phase-2-of-app-password-deprecation ; https://community.atlassian.com/forums/Bitbucket-articles/Deprecation-notice-Bitbucket-Cloud-app-password-brownout/bc-p/3249514 ; https://knowledgebase.autorabit.com/fundamentals/announcements/bitbucket-app-password-deprecation-action-required-before-june-9-2026 ; https://developer.atlassian.com/cloud/bitbucket/oauth-2/ |
| Bitbucket Data Center | HTTP access tokens (older name: personal access tokens), user, project, or repository scope | REST: Basic (user + token) or Bearer. Project and repository tokens work only with Bearer. Tokens also work for Git over HTTPS. | https://confluence.atlassian.com/bitbucketserver/personal-access-tokens-939515499.html |
| Jira Cloud | API token with email (Basic), OAuth 2.0 (3LO) | 3LO needs a registered app and a redirect. That is a cloud dependency for the integration only. | https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/ ; https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/ (not re-fetched in this session: unverified) |
| Jira Data Center | Personal access tokens (Bearer), since Jira 8.14 | Also OAuth 1.0a, Basic, cookie. | https://success.atlassian.com/solution-resources/agile-and-devops-ado/platform-administration/how-to-secure-jira-and-confluence-rest-api-calls-in-data-center |

### Reuse of Git Credential Manager

- `git credential fill` is a Git-defined interface. Input: `protocol`, `host`, `path`. Output: `username`, `password`. Source: https://git-scm.com/docs/git-credential
- GCM supports Bitbucket. `credential.bitbucketAuthModes` selects `oauth` or `basic`. Source: https://support.atlassian.com/bitbucket-cloud/kb/configuring-git-credential-manager-for-windows-utilising-oauth-or-username-and-app-password/ ; https://github.com/git-ecosystem/git-credential-manager
- GCM keeps secrets in Windows Credential Manager. Source: https://github.com/microsoft/Git-Credential-Manager-for-Windows (old project; successor is GCM above).
- Risk: the Git credential for HTTPS may not work for the REST API. Bitbucket Cloud wants the email for API calls but the username for Git. OAuth tokens from GCM may lack API scopes and expire in about an hour (https://github.com/git-ecosystem/git-credential-manager/pull/409). What `git credential fill` returns for Bitbucket OAuth: unverified.
- `git credential fill` can show a GCM prompt. The service must run it only on a user action, with a timeout and cancellation. It must then call `git credential approve` or `reject` per the Git docs.
- Proposal: own token per integration by default. Offer GCM reuse only for Bitbucket Data Center, where an HTTP access token works for both Git and REST.

### Windows Credential Manager through the shell

- The Rust shell stores the token with the OS credential store (for example the `keyring` crate, unverified as the pick). The renderer never sees the token.
- The shell gives the token to the service over the existing service channel for one request. The service holds it only in memory.
- macOS Keychain and Linux Secret Service come later through the same crate.

### Proxy and internal CA in a Bun service

- System CA: Bun accepts `--use-system-ca` (through `BUN_OPTIONS` or `NODE_OPTIONS`) and `NODE_USE_SYSTEM_CA=1`. This reads the Windows certificate store. Sources: https://bun.com/reference/node/tls/getCACertificates ; https://nodejs.org/en/learn/http/enterprise-network-configuration . For a compiled binary, the exact way to set it at build or start time is unverified.
- Proxy: Bun `fetch` reads `HTTP_PROXY` and `HTTPS_PROXY`, and takes a per-request `proxy` option. Source: https://bun.com/docs/guides/http/proxy ; https://bun.com/reference/globals/BunFetchRequestInit/proxy . `NO_PROXY` support: unverified.
- Git's proxy: read `http.proxy` and `http.<url>.proxy` with `git config --get-urlmatch http.proxy <url>` (Git-defined, https://git-scm.com/docs/git-config). Pass it as the `proxy` option. This keeps one proxy setting for Git and the integration.
- Proxy auth (NTLM or Kerberos): Bun support is unverified. Treat it as a known gap.

### Security points

- Tokens never in logs, diagnostics, or error payloads. Reuse the URL redaction and add header redaction.
- A host URL that comes from a remote URL is untrusted. Arbareto sends a token only to a host record that the user created and approved.
- Treat API response text (PR titles, comments, issue summaries) as untrusted text. Never render it as markup.
- Bound response sizes, page counts, and timeouts. A refused request returns a typed error with the HTTP status. Never classify by response message text.

## 7. What Git Extensions does

Ideas only. Git Extensions is GPL. Borrow no code.

- Plugins load through MEF. The loader scans the `Plugins` folder (`GitExtensions.Plugins.*.dll`) and a `UserPlugins` folder (`GitExtensions.*.dll`). Source: DeepWiki https://deepwiki.com/search/how-does-the-plugin-system-loa_84cb92c4-f299-49bd-a8ba-ca4c703625ff
- A plugin implements `IGitPlugin` (`Register`, `Unregister`, `Execute`, settings). Sub-interfaces: `IRepositoryHostPlugin` (pull requests, remotes) and `IGitPluginForCommit` (loads with the commit form). Same source.
- Plugins get `IGitModule` (runs Git commands) and `IGitUICommands` (dialogs, events, menus). They run in-process with full rights. There is no sandbox. Same source.
- Bitbucket plugin: a built-in plugin that was renamed from "Atlassian Stash". It integrates through `IRepositoryHostPlugin`. Its features and REST paths: unverified (DeepWiki had no detail, https://deepwiki.com/search/in-pluginsbitbucketserver-or-b_7f6d539f-a55a-40dc-bfb9-dce9432d2bb8).
- Jira commit hint plugin: a changelog entry reports that it stored credentials in plain text. Same source. Its API calls, JQL, and message template: unverified.

Ideas to borrow:

- A host plugin role with a pull-request dialog behind one interface. For us: a typed operation family, not a plugin API.
- A commit-form hint that lists the user's open issues and inserts text by template.
- A lesson: store credentials in the OS store, not in settings files.

## 8. Rough effort

Feature 003 (remote sync) is the baseline: 90 tasks in `specs/003-remote-sync/tasks.md`. Call it L.

| Item | Size | Compared with 003 |
|---|---|---|
| A. Plugin system | XL | Larger than 003. Sandbox, API versioning, and distribution each add a feature. |
| B. Module frame (host records, credential store, HTTP client with proxy, CA, redaction) | M | About half of 003. |
| C. Browser links | S | A small part of one 003 batch. |
| Bitbucket PR open link (C) | S | |
| Bitbucket PR status on branch labels (B) | M | |
| Bitbucket create PR dialog (B) | M | |
| Jira issue pick plus template (B) | M | |
| Jira status for linked keys (B) | S after the pick | |

## 9. Next steps

1. Finish feature 004.
2. Answer the questions in section 2.
3. Pick the approach and the top features.
4. Run `/speckit-specify` for a new feature with that scope.
5. In `/speckit-plan`, verify the unverified items: Bun CA and proxy in the compiled service, `NO_PROXY`, the create-PR URL forms, and GCM output for Bitbucket.
