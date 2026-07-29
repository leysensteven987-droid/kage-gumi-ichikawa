---
description: Shadow sign-off — confirm work done, harvest durable lessons into memory/skills, commit + push, close clean.
argument-hint: [optional note on what to treat as delivered]
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git fetch:*), Bash(git rebase:*), Bash(git log:*), Bash(git -C:*), Read, Write, Edit, Glob
---

End-of-work sign-off. Treat everything in the current task/turn as complete and delivered, then close the session cleanly. `$ARGUMENTS` (if any) is an extra note on what to treat as delivered.

Run the routine in order:

1. **Confirm what's done.** One tight status line — what shipped this session.

2. **Suggest related follow-up — only if genuine.** Use judgment; one or two directly-related options max. Never invent scope.

3. **Harvest the session.** Review the conversation for anything genuinely useful and durable, and capture it where it belongs:
   - A non-obvious lesson, correction, or preference → bank a memory file in *this project's* memory dir (`~/.claude/projects/<project-slug>/memory/`, the one named in your memory instructions) + index it in `MEMORY.md`. Check for an existing file to update first.
   - A reusable pattern, gotcha, or technique tied to a skill domain (WebCenter, Playwright, etc.) → fold it into the matching `.claude/skills/.../SKILL.md`, in Steven's own voice.
   - Nothing worth keeping → skip silently. Don't manufacture an entry.

   When something is captured, state in one line what was saved and where.

4. **Commit & push — scoped.** Leave clean trees, but only for the files *this session* actually touched (shared-tree git rules — see CLAUDE.md "Git" if this repo has one).
   - `git status` / `git diff HEAD` first. Stage **only** your files with an explicit pathspec — **never** `git add -A` / `git add .`, never a bare `git commit`. If files you didn't touch are staged, leave them out.
   - **This repo:** `git add <files>` → `git commit -o <files> -m "msg"` → `git push origin <current branch>`. Include any skill edits from step 3 (under `.claude/skills/…`) in that same commit. If the push is rejected: ensure your tree is clean, `git fetch origin && git rebase origin/<branch>`, resolve file-by-file, push again. **Never** `git stash` / `reset --hard` / `checkout -- .`.
   - **Memory repo** — only if the memory dir is itself a git repo (check with `git -C "<memory-dir>" rev-parse --git-dir`): if step 3 banked or edited any `memory/*.md` (including `MEMORY.md`), push them there too — `git -C "<memory-dir>" add <files>` → `git -C "<memory-dir>" commit -m "msg"` → `git -C "<memory-dir>" push origin main`. Same collide-at-push rule (clean tree → `fetch` + `rebase origin/main` → push; never `stash`/`reset --hard`). Push the memory repo even when the code commit is empty — a session can produce only a harvested memory.
   - If there's nothing to commit in *either* repo (clean trees, or only another agent's churn like `data/logs.json`), say so and skip — don't manufacture a commit.

5. **Close.** If nothing related remains, sign off with a cool quote in the established Shadow Crew style.

Reference: memory `shadow-delivers-signoff`. Distinct from **shadow executes** (autonomous no-confirm run) and **shadow covers all** (inbox harvest → skills).
