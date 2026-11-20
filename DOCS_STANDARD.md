# ArtisanPack UI Documentation Standard

Every ArtisanPack UI package keeps its user documentation in a `docs/` folder at the repo root. [docs.artisanpackui.dev](https://docs.artisanpackui.dev) builds each package's docs from that folder. This standard defines one structure for all of them, so the same kind of page has the same name, the same place in the sidebar and the same shape in every package.

The [docs-lint workflow](#enforcement) checks most of these rules automatically.

## Layout

```text
docs/
├── home.md                 menu_order: 0     required
├── getting-started.md      menu_order: 10    required
├── installation.md         menu_order: 20    required
├── installation/                             requirements.md, configuration.md, …
├── usage.md                menu_order: 30    required
├── usage/                                    one task-oriented guide per page
├── <feature-section>.md    menu_order: 40–79 package-specific (components, frontend, integrations, ai, …)
├── <feature-section>/
├── advanced.md             menu_order: 80    optional
├── advanced/
├── reference.md            menu_order: 85    required
├── reference/                                configuration.md, hooks.md, functions.md, events.md, commands.md, models.md, rest-api.md, …
├── upgrading.md            menu_order: 90    required from the second major version onward
├── faq.md                  menu_order: 95    required
├── troubleshooting.md      menu_order: 99    required
└── images/                                   screenshots and diagrams
```

### Standard pages

| Page | `menu_order` | Purpose |
|---|---|---|
| `home.md` | 0 | What the package is, its key features, a quick install snippet and where to go next. |
| `getting-started.md` | 10 | The shortest path to a working result: install, the smallest useful example, next steps. Aim for under five minutes. |
| `installation.md` | 20 | Requirements, installing, publishing config/migrations/assets, and configuration. |
| `usage.md` | 30 | Task-oriented guides for everyday use. |
| *package-specific sections* | 40–79 | Topics big enough for their own section, such as `components`, `frontend`, `integrations` or `ai`. |
| `advanced.md` | 80 | Extending, customizing, performance, testing your app with the package. |
| `reference.md` | 85 | Lookup material: configuration keys, hooks, helper functions, public classes and services, events, Artisan commands, models, REST endpoints, TypeScript types. It must be complete. See [Complete references](#complete-references). |
| `upgrading.md` | 90 | What changed between major versions and how to move across. |
| `faq.md` | 95 | Short answers to common questions. |
| `troubleshooting.md` | 99 | Symptoms, causes and fixes. |

The gaps between numbers are there so a package can add a section without renumbering anything.

### Sections and subpages

- **A section's landing page sits beside its folder.** `usage.md` lives next to `usage/`. Never use `usage/usage.md`, `usage/index.md` or `usage/README.md`. The importer treats all of these as the same page, so only one of them gets published.
- **Only add a folder when a section has more than one subpage.** A small package can have a single `installation.md` with no `installation/` folder.
- **Pages inside a section use `menu_order` 10, 20, 30, …** in the order a reader should go through them.
- **Section landing pages introduce the section** in a sentence or two and link to each subpage with a one-line description.
- **Keep nesting to two levels** (`docs/usage/notifications.md`). Go deeper only when a section genuinely needs it.

## Package archetypes

The layout above is the default. Some kinds of package swap or add sections:

| Archetype | Packages | Required top-level pages | Differences |
|---|---|---|---|
| `package` (default) | Laravel packages, JS packages, tooling | home, getting-started, installation, usage, reference, faq, troubleshooting | For tooling (code-style, code-style-pint), usage describes the rules and reference lists every sniff or fixer. For JS packages, installation uses npm and reference covers the TypeScript types. |
| `component-library` | livewire-ui-components, react, vue, design-system | home, getting-started, installation, components, faq, troubleshooting | `components/` at `menu_order: 40` with one page per component. `usage` and `reference` are optional. |
| `starter-kit` | livewire-, react-, vue-starter-kit | home, getting-started, installation, deployment, faq, troubleshooting | Installation describes `composer create-project`. Adds `deployment.md`. |
| `meta` | security-full | home, installation | Home lists the bundled packages and links to each one's docs. |

## Naming

- **kebab-case for every file and folder:** `getting-started.md`, `rest-api.md`, `site-editor/`. No Title-Case, snake_case or spaces.
- **Use the standard name for a standard page.** These names are not allowed at the top level:

  | Instead of | Use |
  |---|---|
  | `api.md`, `api-reference.md`, `api/` | `reference.md`, `reference/` |
  | `quick-start.md`, `overview.md` | `getting-started.md` or `home.md` |
  | `upgrade.md`, `upgrade-guide.md`, `upgrade-1.2.0.md` | `upgrading.md` |

- **Name usage pages after the task**, not the class: `sending-notifications.md`, not `notification-service.md`. Reference pages are the place for class and API names.

## Front matter

Every page starts with front matter:

```yaml
---
title: Configuration
menu_order: 20
meta_description: Every configuration option in config/artisanpack/forms.php and what it does.
---
```

| Field | Required | Notes |
|---|---|---|
| `title` | Yes | Short and in Title Case. It's the sidebar label and page title. The site already shows the package name, so use "Overview", not "ArtisanPack UI Forms Documentation Home". |
| `menu_order` | Yes | A whole number. Standard pages use the fixed values in the layout table. |
| `meta_description` | No | Overrides the description the site generates from the first paragraph. Keep it under 155 characters. |
| `redirect_from` | No | Comma-separated old slugs that should redirect to this page, such as `api/models, Api-Models`. Add it whenever you rename or move a page. The site starts honoring it once [artisanpack-ui-docs#199](https://github.com/ArtisanPack-UI/artisanpack-ui-docs/issues/199) ships. |

Don't use `parent`. The folder structure sets the hierarchy.

## Headings

- **Exactly one H1 per page, matching `title`.** The site removes the H1 and shows the title instead, but the H1 keeps the page readable on GitHub.
- **Use sentence case for H2 and below:** `## Publishing the config file`.
- **Don't skip levels.** An H3 sits under an H2.

## Links

- **Use relative links to the `.md` file:** `[Configuration](installation/configuration.md)`, `[Events](../reference/events.md#form-submitted)`. They work on GitHub, and the site rewrites them to its own URLs.
- **No wiki-style links:** neither `[Configuration](Installation-Configuration)` nor `[[Configuration]]`.
- **Link to other packages with full URLs** to their pages on docs.artisanpackui.dev, never with `../../other-package/docs/…`.
- **Images live in `docs/images/`**, use kebab-case file names and always have alt text: `![The form builder canvas with a text field selected](images/form-builder-canvas.png)`.

## Callouts

The docs site doesn't render GitHub's `> [!NOTE]` alert syntax. It shows `[!NOTE]` as literal text. Use a blockquote that starts with a bold label instead:

```markdown
> **Note:** The config file is only published once. Re-run with `--force` to overwrite it.

> **Warning:** This deletes every submission for the form and can't be undone.
```

Use the labels **Note**, **Tip** and **Warning**. Keep callouts rare, because one per section loses its effect.

## Code

- **Tag every code block with a language:** `php`, `blade`, `bash`, `js`, `ts`, `tsx`, `vue`, `json`, `yaml`, `env`. Use `text` for plain output.
- **Code samples follow the package's code style.** PHP uses WordPress-style spacing and Yoda conditions, like the package source.
- **Samples should run as written.** Include the `use` statements a reader needs, and show the file path in a comment when it isn't obvious (`// config/artisanpack/forms.php`).
- **Write shell commands without a prompt** (`composer require …`, not `$ composer require …`) so they can be copied.

## Page templates

### Home

~~~markdown
---
title: Overview
menu_order: 0
---

# Overview

One or two sentences on what the package does and who it's for.

## Features

- A short list of the main capabilities.

## Requirements

PHP, Laravel and any other version requirements.

## Quick install

```bash
composer require artisanpack-ui/<package>
```

## Next steps

- [Getting started](getting-started.md): a working example in five minutes.
- [Usage](usage.md): guides for everyday tasks.
- [Reference](reference.md): configuration, hooks, events and APIs.
~~~

Don't hand-write a table of contents. The sidebar already has one, and hand-written ones drift out of date.

### Reference entry

~~~markdown
## `apUploadMedia()`

Uploads a file and creates a media record.

| Parameter | Type | Description |
|---|---|---|
| `$file` | `UploadedFile` | The uploaded file. |
| `$options` | `array` | Optional `title`, `alt_text` and `folder_id`. |

**Returns:** `Media`, the created record.

**Since:** 1.0.0

```php
$media = apUploadMedia( $request->file( 'image' ), [
	'alt_text' => __( 'Product photo' ),
] );
```
~~~

### Troubleshooting entry

```markdown
## Uploads fail with "The file could not be stored"

**Cause:** The `public` disk isn't linked.

**Fix:** Run `php artisan storage:link`.
```

## Complete references

A developer should never have to read a package's source to find out what it lets them hook into or call. The reference has to list **all** of the following that the package has, not a selection:

- **Every hook it fires.** Each filter (`applyFilters()`) and action (`doAction()`), in PHP, Blade and JavaScript, goes in `reference/hooks.md`, or in a `## Hooks` section of `reference.md` for a small package. Give each one its name, whether it's a filter or an action, its arguments with types, what a filter must return, when it runs and **Since:**. Document names built at runtime with a placeholder, such as `ap.forms.table.{screen}.columns`, and list the values the placeholder can take.
- **Hooks from other packages that it applies or subscribes to,** when that changes what a developer sees. List them in their own table with the package that owns each one.
- **Every helper function it exposes.** Each global function (the files in Composer's `autoload.files`) and each exported JavaScript function goes in `reference/functions.md`, or in a `## Functions` section of `reference.md` for a small package with no other reference subpages, using the [reference entry](#reference-entry) template. Keep autoloaded helper files in `src/` so the docs-lint workflow runs when they change. For example, the accessibility package's `a11yCheckContrastColor()` and `generateAccessibleTextColor()`.
- **The public PHP API meant for apps to use.** Facades, registries, services, contracts and base classes to implement or extend, traits for app components, and the public constants (event names, hook-name constants) that go with them. Put them in `reference/php-api.md` or one page per area. List every public method on each, not just the common ones. Usage and extending guides show how to use them, and the reference lists the whole surface and links back to those guides.
- **Browser and Livewire events, Blade components and Artisan commands** that the package dispatches, registers or ships, each with its payload, props or options.

Mark anything public that apps shouldn't use with `@internal` in the source and leave it out of the docs. Anything without that tag counts as public.

When a change adds, renames or removes any of these, update the reference in the same pull request.

## Versions and upgrades

- **The docs describe the current major version.** Note features added in a minor release with **Since:** on reference entries or a short note in guides.
- **`upgrading.md` has one `##` heading per major version,** newest first, listing breaking changes and the steps to move across. When one major version's guide gets long, split it into `upgrading/v3.md` and keep `upgrading.md` as the landing page.
- **Minor releases don't get upgrade guides.** Their changes belong in `CHANGELOG.md`.

## What doesn't belong in `docs/`

`docs/` holds only pages written for people using the package.

| Content | Where it goes |
|---|---|
| Plans, audits, decision records, research notes | `.planning/` at the repo root (decision records in `.planning/decisions/`) |
| Changelog | `CHANGELOG.md` at the repo root |
| Contributor guide, local setup, running the package's own tests | `CONTRIBUTING.md` at the repo root |
| AI agent guidelines | `resources/boost/guidelines/` or the package's existing AI guideline location |

## Enforcement

The docs-lint workflow checks every pull request that touches `docs/`, `src/`, `resources/` or `composer.json`. It reports:

- file and folder names that aren't kebab-case
- missing required pages for the archetype
- non-standard names (`api.md`, `quick-start.md`, `upgrade-1.2.0.md`, …)
- section folders without a landing page beside them, and duplicate landing pages inside them
- internal folders (`plans/`, `audits/`, `design/`, `benchmarks/`, `decisions/`, …), changelogs and contributor docs inside `docs/`
- missing `title` or `menu_order`, and standard pages using the wrong `menu_order`
- pages with no H1, more than one H1, or an H1 that doesn't match `title`
- wiki-style links, links without `.md`, and relative links to files that don't exist
- GitHub alert syntax and code blocks with no language
- hooks the package fires (from `src/` and `resources/`) and public helper functions in Composer's `autoload.files` that no docs page mentions, and autoloaded helper files outside `src/` (warnings for now). It skips comments, test files and anything tagged `@internal`. It can only check hook names written as a plain string or as a class constant, so names built at runtime still need checking by hand.

### Adding it to a package

In the package repo, go to **Actions → New workflow** and choose **Docs lint** under "By ArtisanPack-UI". Or copy [`workflow-templates/docs-lint.yml`](workflow-templates/docs-lint.yml) to `.github/workflows/docs-lint.yml` and replace `$default-branch` with the repo's default branch (usually `main`). GitHub only fills that placeholder in when you use **New workflow**. Then set `archetype` if the package isn't a standard `package`:

```yaml
jobs:
  docs-lint:
    uses: ArtisanPack-UI/.github/.github/workflows/docs-lint.yml@main
    with:
      archetype: component-library
```

New packages created from `package-blueprint` already include the workflow and a `docs/` skeleton that passes it.

### Running it locally

```bash
curl -sO https://raw.githubusercontent.com/ArtisanPack-UI/.github/main/scripts/docs-lint.mjs
node docs-lint.mjs docs --archetype=package
```

It needs Node 18 or newer and has no dependencies. Its own regression tests live in `scripts/docs-lint.test.mjs`. Run them with `node --test scripts/docs-lint.test.mjs`.

## Migrating a package

`scripts/docs-migrate.mjs` does the mechanical part of a migration. Run it from the package root. It prints the plan by default and only changes files with `--write`:

```bash
curl -sO https://raw.githubusercontent.com/ArtisanPack-UI/.github/main/scripts/docs-migrate.mjs
node docs-migrate.mjs docs            # dry run
node docs-migrate.mjs docs --write    # apply
```

Pass `--archetype=component-library` (or `starter-kit`, `meta`) when it applies, so slots like `components` at 40 are kept free.

It does the following:

- moves internal folders to `.planning/`
- renames files and folders to kebab-case and the standard names
- merges duplicate landing pages, keeping the copy the site actually published (drafts, hidden pages and `.docsignore` matches never win), and points links at the page it kept
- rewrites wiki-style and moved links to relative `.md` links, and links to source files to GitHub URLs
- adds `redirect_from` for every slug that changes
- sets `title`, `menu_order` and a matching H1, ordering pages the way the home and section pages link to them
- demotes extra H1s, tags untagged code blocks with a best-guess language and converts GitHub alerts

It never writes new content. It keeps `.docsignore` and adds renamed pages to it, refuses to run on the repo root or a `docs/` with symbolic links, and won't overwrite existing files in `.planning/`. Removed files that git doesn't track go to `.planning/removed-docs/` rather than being deleted. Afterwards:

1. Review the diff, especially the guessed code block languages, the reordered sidebar and any pages the script reports it dropped or left in place.
2. Fix whatever `docs-lint.mjs` still reports: links it couldn't resolve, missing landing and required pages, changelogs or contributor docs inside `docs/`, per-version upgrade pages to fold into `upgrading.md`, and similar.
3. Remove any hand-written table of contents from `home.md` and make the page follow the [home template](#home).
4. Add the docs-lint workflow and get it passing.
5. Update the package's row in [discussion #13](https://github.com/orgs/ArtisanPack-UI/discussions/13).
