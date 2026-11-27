#!/usr/bin/env bash
set -euo pipefail

project_root="${T3CODE_PROJECT_ROOT:-$PWD}"
worktree_path="${T3CODE_WORKTREE_PATH:-$PWD}"

if [[ ! -d "$project_root" ]]; then
  printf 'T3 project root does not exist: %s\n' "$project_root" >&2
  exit 1
fi
if [[ ! -d "$worktree_path" ]]; then
  printf 'Worktree path does not exist: %s\n' "$worktree_path" >&2
  exit 1
fi

project_root="$(cd "$project_root" && pwd -P)"
worktree_path="$(cd "$worktree_path" && pwd -P)"
cd "$worktree_path"

# Share local configuration with the main checkout. Add other gitignored files
# here as needed. Existing regular files in a worktree are never overwritten.
shared_files=(
  ".env"
)

if [[ "$project_root" != "$worktree_path" ]]; then
  for relative_path in "${shared_files[@]}"; do
    source_path="$project_root/$relative_path"
    target_path="$worktree_path/$relative_path"

    [[ -f "$source_path" ]] || continue

    if [[ -e "$target_path" && ! -L "$target_path" ]]; then
      printf 'Keeping worktree-specific %s\n' "$relative_path"
      continue
    fi

    if [[ -L "$target_path" && "$(readlink "$target_path")" == "$source_path" ]]; then
      printf 'Already linked %s\n' "$relative_path"
      continue
    fi

    rm -f "$target_path"
    mkdir -p "$(dirname "$target_path")"
    ln -s "$source_path" "$target_path"
    printf 'Linked %s from the main checkout\n' "$relative_path"
  done
fi

pnpm install --frozen-lockfile

# The dev server serves this build; dist/ is not present in a fresh worktree.
pnpm --dir packages/control-plane gui:build

# Add future worktree initialization (code generation, migrations, etc.) here.
