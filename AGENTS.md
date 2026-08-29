# Browser development

Wplace does not work in the T3 Code browser. Use `Chromium.app` in debug mode for all Wplace
browser work. The `pnpm dev` command starts this browser, but the user likely already has one
running. Check for an existing debug Chromium browser before starting another one.

# Userscript release notes

Add one new Changeset file for each atomic, user-visible userscript change. Use one short summary
sentence. Add nested bullets only for closely related parts of the same change. Keep pending
Changeset files immutable so each released top-level bullet stays linked to its own commit.
