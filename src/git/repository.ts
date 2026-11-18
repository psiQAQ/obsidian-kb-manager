import * as fs from 'node:fs';
import * as path from 'node:path';
import git from 'isomorphic-git';

// Callers supply the verified physical root of a single knowledge base.
export function repository(dir: string) {
 return { fs, dir, gitdir: path.join(dir, '.git') };
}

export async function initializeRepository(dir: string): Promise<void> {
 const repo = repository(dir);
 // Exclusive reservation also rejects linked worktrees and existing repositories.
 await fs.promises.mkdir(repo.gitdir);
 await git.init({ ...repo, defaultBranch: 'main' });
}
