/**
 * setup_github: initialize git repo, create a PRIVATE repository on GitHub, and push.
 *
 * What this tool will not do, whatever it is asked:
 *   - run outside a project directory (package.json + .gitignore; not the home
 *     directory, a directory above it, or a filesystem root);
 *   - create a public repository. `private: false` is accepted and ignored: making a
 *     repository public is a step for its owner, not for a tool a model can call;
 *   - push to a repository that already exists;
 *   - commit or push a file that looks like a secret, whether it is in the working
 *     tree, already staged or tracked, or anywhere in the existing history.
 *
 * "Would git commit this file" is decided by git (`git check-ignore`), never by
 * reading .gitignore here.
 */

import { resolve } from "node:path";
import { lstatSync } from "node:fs";
import { runCommand } from "../services/subprocess.js";
import { checkProjectDir, sameEntry } from "../services/path-guard.js";
import {
  describeHits,
  findSecretLookingFiles,
  isSecretTemplate,
  listForMessage,
  looksLikeSecret,
  scanTemplates,
  SECRET_PATTERNS_TEXT,
} from "../services/secret-scan.js";

/** Injectable so tests can observe the commands without running git or gh. */
export type CommandRunner = typeof runCommand;

/** GitHub's rule for a repository name, plus: no leading dash, no owner prefix. */
const REPO_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;

/**
 * One sentence, in every successful result. `repo` is "owner/name" when gh reported
 * it, so the command can be pasted as it is.
 */
export function makePublicSentence(repo: string): string {
  return (
    "The repository is private, and making it public is the owner's own step (a free marketplace listing needs a public one): " +
    `run \`gh repo edit ${repo} --visibility public --accept-visibility-change-consequences\` yourself when you are ready.`
  );
}

const HOW_TO_FIX =
  "If they are secrets, add them to .gitignore or delete them. If they are not, rename them " +
  "(a template such as .env.example is allowed). Then call setup_github again. " +
  `File names treated as secrets: ${SECRET_PATTERNS_TEXT}.`;

const refuse = (error: string): string => JSON.stringify({ success: false, error }, null, 2);

const splitNul = (out: string): string[] => out.split("\0").filter((s) => s.length > 0);

/** "owner/name" and visibility of an existing GitHub repository, or null when gh finds none. */
async function existingRepo(run: CommandRunner, cwd: string, repo: string): Promise<{ name: string; visibility: string } | null> {
  const res = await run(["gh", "repo", "view", "--json", "nameWithOwner,visibility", "--", repo], { cwd, timeout: 30_000 });
  if (!res.success) return null;
  try {
    const data = JSON.parse(res.stdout) as { nameWithOwner?: unknown; visibility?: unknown };
    return { name: String(data.nameWithOwner ?? repo), visibility: String(data.visibility ?? "unknown").toLowerCase() };
  } catch {
    return { name: repo, visibility: "unknown" };
  }
}

function refuseExisting(found: { name: string; visibility: string }, how: string): string {
  if (found.visibility === "public") {
    return refuse(
      `setup_github refused: ${how} ${found.name}, which is PUBLIC. This tool never pushes to a public repository: ` +
      "anything pushed there is published at once, and that decision belongs to the owner. Push with git yourself if that is what you want. Nothing was staged."
    );
  }
  return refuse(
    `setup_github refused: ${how} ${found.name} (${found.visibility}), which already exists. This tool only creates a new private repository; ` +
    "it does not push to an existing one. Push with git yourself, or choose a different repo_name. Nothing was staged."
  );
}

/** A refusal when a template holds a credential-shaped value or cannot be read; null when all are clean. */
function refuseTemplates(absDir: string, templates: string[], tail: string): string | null {
  const { hits, unscannable } = scanTemplates(absDir, templates);
  if (unscannable.length > 0) {
    return refuse(
      `setup_github refused: could not read ${listForMessage(unscannable)} in full, so it cannot confirm the template holds no real credential. ${tail}`
    );
  }
  if (hits.length > 0) {
    return refuse(
      `setup_github refused: a template file holds ${hits.length === 1 ? "a value" : "values"} shaped like a live credential: ${describeHits(hits)}. ` +
      `A template is committed and pushed, so it must hold placeholders only. Replace the value (and rotate it if it was real), then call setup_github again. ${tail}`
    );
  }
  return null;
}

export async function setupGithub(
  projectDir: string,
  repoName: string,
  description: string = "",
  isPrivate: boolean = true,
  run: CommandRunner = runCommand
): Promise<string> {
  // The name is handed to gh as an argument: only a plain repository name may get there.
  if (typeof repoName !== "string" || !REPO_NAME.test(repoName) || repoName === "." || repoName === "..") {
    return refuse(
      `setup_github refused: repo_name ${JSON.stringify(repoName)} is not a valid repository name. Use letters, digits, "-", "_" and "." ` +
      "(at most 100 characters), not starting with a dash, and without an owner prefix: the repository is created under your own account."
    );
  }
  if (typeof description !== "string" || description.length > 350) {
    return refuse("setup_github refused: description must be a string of at most 350 characters.");
  }

  // Before anything runs: is this a project we should be staging and pushing?
  const check = checkProjectDir(projectDir, "setup_github", { requireGitignore: true });
  if (!check.ok) {
    return JSON.stringify({ success: false, error: check.error });
  }
  const absDir = check.absDir;

  // Check gh is available
  const ghCheck = await run(["gh", "--version"]);
  if (!ghCheck.success) {
    return JSON.stringify({
      success: false,
      error: 'gh CLI not found. Install from https://cli.github.com and run "gh auth login".',
    });
  }

  // git init if needed. This comes BEFORE the checks below on purpose:
  // `git check-ignore` exits 128 outside a repository, with or without --no-index.
  const dotGit = resolve(absDir, ".git");
  let dotGitStat: ReturnType<typeof lstatSync> | null = null;
  try {
    dotGitStat = lstatSync(dotGit);
  } catch {
    dotGitStat = null;
  }
  if (dotGitStat && !dotGitStat.isDirectory()) {
    // A .git FILE (or link) means the git directory is somewhere else: a linked
    // worktree, a submodule checkout, or a repository made with --separate-git-dir.
    return refuse(
      `setup_github refused: ${dotGit} is a ${dotGitStat.isSymbolicLink() ? "symbolic link" : "file"}, not a directory. That is a linked worktree, a submodule checkout, ` +
      "or a repository whose git directory lives elsewhere, and staging or committing here would change ANOTHER repository. " +
      "Run this tool in a project that has its own .git directory. Nothing was changed."
    );
  }
  if (!dotGitStat) {
    const initResult = await run(["git", "init"], { cwd: absDir });
    if (!initResult.success) {
      return JSON.stringify({ success: false, error: `git init failed: ${initResult.stderr}` });
    }
  }

  // The repository git will act on must be THIS directory's own .git, by identity:
  // its git directory, its common directory (they differ in a linked worktree) and its
  // work tree. "The top level is the project" alone is also true of a worktree.
  const gitDir = await run(["git", "rev-parse", "--absolute-git-dir"], { cwd: absDir });
  const commonDir = await run(["git", "rev-parse", "--git-common-dir"], { cwd: absDir });
  const topLevel = await run(["git", "rev-parse", "--show-toplevel"], { cwd: absDir });
  const ownRepository =
    gitDir.success && commonDir.success && topLevel.success &&
    sameEntry(gitDir.stdout.trim(), dotGit) &&
    sameEntry(resolve(absDir, commonDir.stdout.trim()), dotGit) &&
    sameEntry(topLevel.stdout.trim(), absDir);
  if (!ownRepository) {
    return refuse(
      `setup_github refused: git would not use ${dotGit} as this project's own repository (git directory: ${gitDir.stdout.trim() || "unknown"}; ` +
      `common directory: ${commonDir.stdout.trim() || "unknown"}; work tree: ${topLevel.stdout.trim() || "unknown"}). ` +
      "Staging or committing here could change another repository. Nothing was changed."
    );
  }

  // --- Never push to a repository that already exists (and say so plainly when it is public).
  const origin = await run(["git", "remote", "get-url", "origin"], { cwd: absDir });
  if (origin.success && origin.stdout.trim() !== "") {
    const url = origin.stdout.trim();
    const found = (await existingRepo(run, absDir, url)) ?? { name: url, visibility: "visibility unknown" };
    return refuseExisting(found, "this project already has a remote named origin,");
  }
  const sameName = await existingRepo(run, absDir, repoName);
  if (sameName) {
    return refuseExisting(sameName, "you already have a repository named");
  }

  // --- Check 1, before staging: secret-looking files that git would add.
  const scan = findSecretLookingFiles(absDir);
  if (scan.unreadable.length > 0) {
    return refuse(
      `setup_github refused: could not read ${listForMessage(scan.unreadable)} in ${absDir}, so it cannot confirm that no secret would be committed. Nothing was staged.`
    );
  }
  const exposed: string[] = [];
  for (const file of scan.files) {
    // Plain check-ignore (index-aware), one path per call so no output has to be parsed:
    // exit 0 = ignored, 1 = not ignored, anything else = git could not answer.
    // Not --no-index: a file that is already tracked is committed whatever .gitignore
    // says, and the index-aware form reports it as not ignored, which is the truth we need.
    const res = await run(["git", "check-ignore", "-q", "--", file], { cwd: absDir });
    if (res.returnCode === 0) continue;
    if (res.returnCode === 1) {
      exposed.push(file);
      continue;
    }
    return refuse(
      `setup_github refused: git could not say whether ${file} is ignored (exit ${res.returnCode}: ${res.stderr.trim()}). Nothing was staged.`
    );
  }
  if (exposed.length > 0) {
    return refuse(
      `setup_github refused: ${exposed.length === 1 ? "this file looks like a secret" : "these files look like secrets"} ` +
      `and git would commit ${exposed.length === 1 ? "it" : "them"}: ${listForMessage(exposed)}. ${HOW_TO_FIX} Nothing was staged.`
    );
  }

  // --- Templates of secret files (.env.example, .env.template, ...) are allowed by name, so their CONTENT
  // is checked: a template that git would commit must not hold a live-looking credential.
  const committedTemplates: string[] = [];
  for (const file of scan.templates) {
    const res = await run(["git", "check-ignore", "-q", "--", file], { cwd: absDir });
    if (res.returnCode === 0) continue;
    if (res.returnCode !== 1) {
      return refuse(
        `setup_github refused: git could not say whether ${file} is ignored (exit ${res.returnCode}: ${res.stderr.trim()}). Nothing was staged.`
      );
    }
    committedTemplates.push(file);
  }
  const templateRefusal = refuseTemplates(absDir, committedTemplates, "Nothing was staged.");
  if (templateRefusal) return templateRefusal;

  // --- The .gitignore has to WORK, not merely exist: git must ignore the two things
  // that should never be committed from a Node project, even when neither is there yet.
  const notIgnored: string[] = [];
  for (const [probe, label] of [["node_modules/x", "node_modules/"], [".env", ".env"]] as const) {
    const res = await run(["git", "check-ignore", "-q", "--", probe], { cwd: absDir });
    if (res.returnCode === 0) continue;
    if (res.returnCode === 1) {
      notIgnored.push(label);
      continue;
    }
    return refuse(
      `setup_github refused: git could not say whether ${label} is ignored (exit ${res.returnCode}: ${res.stderr.trim()}). Nothing was staged.`
    );
  }
  if (notIgnored.length > 0) {
    return refuse(
      `setup_github refused: git would not ignore ${notIgnored.join(" or ")} in ${absDir} (missing from .gitignore, or already tracked). ` +
      "This tool stages every file, so both must be ignored first. Add the lines node_modules/ and .env to .gitignore, then call setup_github again. Nothing was staged."
    );
  }

  // --- History: everything reachable is pushed, not only what is in the working tree.
  // A secret committed earlier and removed since is still in those commits.
  // (-c log.showRoot=true and -m: also list the first commit's files and a merge's.)
  const history = await run(
    ["git", "-c", "log.showRoot=true", "log", "--all", "-m", "--name-only", "-z", "--pretty=format:"],
    { cwd: absDir }
  );
  if (!history.success) {
    return refuse(
      `setup_github refused: could not list the files in this repository's history (exit ${history.returnCode}: ${history.stderr.trim()}), ` +
      "so it cannot confirm that no secret would be pushed. Nothing was staged."
    );
  }
  const historySecrets = [...new Set(history.stdout.split(/[\0\n]/).filter((p) => p.length > 0))].filter(looksLikeSecret).sort();
  if (historySecrets.length > 0) {
    return refuse(
      `setup_github refused: this repository's history contains ${historySecrets.length === 1 ? "a file that looks like a secret" : "files that look like secrets"}: ` +
      `${listForMessage(historySecrets)}. Pushing publishes every commit, including ones where a file was later deleted or ignored. ` +
      "If these were real secrets, clean the history first (for example with git filter-repo) and rotate them. If they were not, a file " +
      "name that stays in old commits still blocks this tool, so either way the simple route is to start a fresh repository " +
      "(move the .git directory away and call setup_github again). Nothing was staged."
    );
  }

  // --- Stage. Only now, and the result is checked again below: a file created between
  // check 1 and this command is staged by it too.
  const addResult = await run(["git", "add", "-A"], { cwd: absDir });
  if (!addResult.success) {
    return refuse(`setup_github refused: git add failed: ${addResult.stderr.trim()}`);
  }

  // --- Check 2, after staging: what the commit will actually contain.
  // `git diff --cached` is what this staging changed; `git ls-files` is the whole index.
  const staged = await run(["git", "diff", "--cached", "--name-only", "-z"], { cwd: absDir });
  const tracked = await run(["git", "ls-files", "-z"], { cwd: absDir });
  if (!staged.success || !tracked.success) {
    await run(["git", "reset", "-q"], { cwd: absDir });
    return refuse(
      "setup_github refused: could not list what was staged, so it cannot confirm that no secret would be committed. Everything was unstaged; nothing was committed."
    );
  }
  const stagedSecrets = [...new Set([...splitNul(staged.stdout), ...splitNul(tracked.stdout)])]
    .filter(looksLikeSecret)
    .sort();
  if (stagedSecrets.length > 0) {
    for (let i = 0; i < stagedSecrets.length; i += 100) {
      await run(["git", "reset", "-q", "--", ...stagedSecrets.slice(i, i + 100)], { cwd: absDir });
    }
    return refuse(
      `setup_github refused: ${stagedSecrets.length === 1 ? "a file that looks like a secret is" : "files that look like secrets are"} ` +
      `staged or already tracked: ${listForMessage(stagedSecrets)}. ${HOW_TO_FIX} ` +
      "They were unstaged; nothing was committed or pushed."
    );
  }

  // The same content check for any template that is staged or tracked now (one could
  // have appeared since the first look).
  const stagedTemplates = [...new Set([...splitNul(staged.stdout), ...splitNul(tracked.stdout)])].filter(isSecretTemplate).sort();
  const stagedTemplateRefusal = refuseTemplates(absDir, stagedTemplates, "Everything was unstaged; nothing was committed.");
  if (stagedTemplateRefusal) {
    await run(["git", "reset", "-q"], { cwd: absDir });
    return stagedTemplateRefusal;
  }

  // Commit exactly the index that was just checked (no -a: nothing is staged again here).
  await run(["git", "commit", "-m", "Initial commit"], { cwd: absDir });
  // Commit may fail if nothing to commit: that is ok

  // Create the GitHub repository: ALWAYS private. The name comes after "--", so it can
  // never be read as an option.
  const args = ["gh", "repo", "create", "--private", "--source", ".", "--push"];
  if (description) {
    args.push(`--description=${description}`);
  }
  args.push("--", repoName);

  const createResult = await run(args, { cwd: absDir, timeout: 30_000 });

  if (!createResult.success) {
    return JSON.stringify({
      success: false,
      error: createResult.stderr,
      stdout: createResult.stdout,
      hint: "Common fixes: check gh auth, ensure repo name is available.",
    });
  }

  // Extract repo URL, and "owner/name" from it for the make-public command.
  const repoUrl = createResult.stdout.trim().split("\n")[0] || `https://github.com/${repoName}`;
  const ownerAndName = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(repoUrl)?.[1] ?? `<owner>/${repoName}`;
  const askedForPublic = isPrivate === false;

  return JSON.stringify({
    success: true,
    repoUrl,
    repoName,
    private: true,
    visibility: "private",
    publicRequestIgnored: askedForPublic,
    nextSteps: [
      `GitHub repo created (private): ${repoUrl}`,
      ...(askedForPublic ? ["private=false was ignored: this tool never creates a public repository."] : []),
      makePublicSentence(ownerAndName),
      "Use generate_launchguide to create LAUNCHGUIDE.md for marketplace submission.",
    ],
  }, null, 2);
}
