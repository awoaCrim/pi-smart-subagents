# Release and repository maintenance

This is an independent community fork of Luke Parke's `@parke.dev/pi-subagent`. Preserve the original [MIT license](../LICENSE), copyright and upstream attribution. Do not publish under the upstream scope. This standalone repository does not inherit the upstream monorepo's tag automation.

---

### Choose the scope first

A README or repository-presentation update does not require a new npm version, tag, GitHub Release, package installation or binary upload. An edit to a Release body should change only that body. A new package release is a separate operation with artifact verification and explicit publication approval.

Read [package.json](../package.json), [CHANGELOG.md](../CHANGELOG.md), the working tree and index before making changes. Record the original local HEAD, remote main and any remote metadata you intend to update. Preserve unrelated modifications and existing commit history by default. A separately approved single-root conversion must follow the history-replacement safeguards below; do not infer that permission from a documentation update or another project’s release rules.

---

### Public source-tree boundary

Commit production source, the distributed [subagent skill](../skills/subagent/SKILL.md), public documentation and package metadata. Keep local maintainer tooling and private artifacts out of the public tree: `.trellis/`, `.agents/`, `.codex/`, project-local `.pi/` configuration, `AGENTS.md`, `LOCAL-PATCH.md`, Trellis-named support files, credentials, sessions, logs, dependencies, generated bundles and tarballs.

The product directory [skills/](../skills/) is not the local `.agents/skills/` directory. Never remove the product skill merely because local workflow skills are excluded. No Actions workflow or contributor guide is required for this manual release process.

Do not stage or discard local `.gitignore` edits. Where exclusion rules are maintained in `.git/info/exclude`, preserve its existing content and keep that file local. Ignore rules do not untrack files already in Git. When a reviewed cleanup needs to stop tracking local files, use `git rm --cached -- <explicit paths>` after backing them up and verifying their contents; never delete the working copies to clean the public tree. An ordinary commit does not erase those files from older history.

---

### Documentation-only source updates

Keep [README.md](../README.md) and [README.zh-CN.md](../README.zh-CN.md) synchronized in the same change. Preserve the language switch, package identity, original copyright and license links. Each README ends with one Linux.do acknowledgement; do not expand it into a community/contact section. Do not add a documentation-index table, contribution guide or stale release-promotion block to the landing page.

Run the relevant [development checks](DEVELOPMENT.md), including relative-link and translation review, whitespace checks and the package dry run. A fresh checkout has no bundled test runner or typecheck script; do not claim upstream/private harness commands are available.

Stage only explicitly reviewed paths. For example, when both README files are the complete change:

```bash
git add -- README.md README.zh-CN.md
```

Inspect the staged names:

```bash
git diff --cached --name-status
```

Inspect the actual staged patch:

```bash
git diff --cached
```

Create an ordinary commit after reviewing and approving its scope. Do not use broad `git add -A`, `--amend -a`, history squashing or a force push for documentation maintenance.

Before an authorized push, re-read remote main and compare it with the value saved at the start. Stop on an unexplained change rather than accepting a new baseline. The local branch can be named differently from remote main; target the reviewed commit deliberately:

```bash
git push origin HEAD:refs/heads/main
```

Use a normal fast-forward push for ordinary maintenance. Afterward, confirm local HEAD and remote main match, read back affected files, and verify the intended current tree no longer exposes local-only paths. Update GitHub About fields only when that specific edit was approved, and re-read them afterward. Source push and About edits can succeed separately; report their actual status separately.

---

### Explicitly approved history replacement

Only replace the main history when the repository owner has explicitly requested that scope. Preserve the original graph in a local-only backup ref and an external Git bundle, verify the bundle in a separate repository, and retain working-file and index backups. Construct a parentless candidate from the reviewed public tree; verify its tree and that its reachable history contains exactly one commit before changing the local branch. Local maintenance files must remain on disk.

Before replacing remote main, obtain approval for the exact candidate and original remote SHA. Recheck remote state and use an explicit `--force-with-lease=refs/heads/main:<original-sha>` with only `<candidate-sha>:refs/heads/main`. Stop if the lease fails; never refresh the expected SHA to bypass it. Do not push backup refs, use an unqualified force or alter tags and other branches.

Read back the remote commit, parent list and tree after the update. A single-root main history does not erase old objects from GitHub caches, other clones or local backups. It also does not authorize npm publication, installation or About changes.

---

### Prepare an npm release

Only perform this section for an approved version release:

1. Choose an unpublished version and update package metadata and changelog together. Keep README install examples consistent with the intended release.
2. Run the checks available in the actual environment, as described in [development](DEVELOPMENT.md). A syntax transform is not a semantic typecheck. Record missing tooling and any separately configured typecheck/fixture results. Do not run real provider calls without permission.
3. Inspect the package dry-run list for unexpected files.
4. Pack the source, record the tarball's integrity, and test the packed source in an isolated installation where suitable offline verification is available. Do not imply a missing harness was run.
5. Review the final name, version, tarball, contents and verification results before requesting publication approval.

Dry-run contents:

```bash
npm pack --dry-run --ignore-scripts --json
```

Create the release artifact only when preparing a release:

```bash
npm pack --ignore-scripts
```

Install the reviewed artifact into a separate temporary prefix using `--ignore-scripts --legacy-peer-deps` if installation checks are part of the approved release scope. Never replace the working Pi installation merely to inspect a package.

---

### Publish with verified TLS

Use an existing npm login or a securely supplied environment-based credential. Never put tokens in command text, source files, a committed `.npmrc` or diagnostics.

If the environment contains `NODE_TLS_REJECT_UNAUTHORIZED=0`, remove that override before any credential-bearing registry operation. `--strict-ssl=true` does not undo a Node-level TLS override.

In Bash:

```bash
unset NODE_TLS_REJECT_UNAUTHORIZED
```

In PowerShell:

```powershell
Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue
```

Check the authenticated account without displaying credentials:

```bash
npm whoami --strict-ssl=true --registry=https://registry.npmjs.org/
```

After explicit approval, publish the reviewed tarball. Replace `<version>` with the approved version:

```bash
npm publish "./cr1ms0n-pi-subagent-<version>.tgz" --access public --ignore-scripts --strict-ssl=true --registry=https://registry.npmjs.org/
```

Read the exact version's registry metadata:

```bash
npm view "@cr1ms0n/pi-subagent@<version>" name version dist.integrity --strict-ssl=true --registry=https://registry.npmjs.org/
```

Registry propagation can lag. A successful publish is not proof that the exact version is already readable. Verify name/version/integrity against the reviewed local artifact before replacing an installation; do not repeat a publication blindly after an uncertain response. All files in a published tarball become public.

GitHub tags, Releases and attachments are separate from npm publication. Do not create or modify them implicitly. If explicitly requested, inspect the existing remote objects, use a tool that actually supports the operation, update only the approved fields/assets, then read back and verify the result.

---

### Install and replace

Installation is a separate local change. After artifact verification and approval, replace `<version>` with the verified release:

```bash
pi install "npm:@cr1ms0n/pi-subagent@<version>"
```

Back up the old package selection/source and keep it for rollback. Do not enable this fork and `@parke.dev/pi-subagent` simultaneously: both register the same tools. Verify the physical installed package version and files rather than relying only on a command's exit status or the settings entry. Reload or restart Pi after changing packages.

This fork uses the same configuration and persisted-state paths as upstream. Switching packages is not a data migration. Do not overwrite model choices or credentials during upgrades. Configure `jevRouting` in `~/.pi/subagent.json` before starting new tasks, as described in the [reference](REFERENCE.md#jev-routing).

Report preparation, publication, remote synchronization and local installation as distinct states, including checks that could not be performed.
