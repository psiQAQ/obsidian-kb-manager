import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import git from 'isomorphic-git';
import { initializeRepository, repository } from '../src/git/repository.ts';
import { existingDirectory, segments } from '../src/fs/paths.ts';

test('portable path components', () => {
 for (const bad of ['../x', 'a//b', '/a', 'C:/a', 'a\\b', 'COM1.txt', 'x.', '.git', 'nul']) {
  assert.throws(() => segments(bad));
 }
 assert.deepEqual(segments('资料/光学 研究'), ['资料', '光学 研究']);
});

test('two repositories retain independent same-name files through directory rename', async t => {
 await fs.mkdir('.tmp', { recursive: true });
 const root = await fs.mkdtemp(path.resolve('.tmp','vault-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const read = (dir, ...args) => execFileSync('git', ['-C', dir, ...args]);
 const heads = [];
 for (const [i, name] of ['光学 研究', '量子计算'].entries()) {
  await fs.mkdir(path.join(root, name));
  const dir = await existingDirectory(root, name);
  await initializeRepository(dir);
  await assert.rejects(initializeRepository(dir));
  assert.equal(read(dir, 'symbolic-ref', '--short', 'HEAD').toString().trim(), 'main');
  assert.equal(read(dir, 'for-each-ref').length, 0);
  const repo = repository(dir);
  for (const [file, bytes] of [['同名.md', Buffer.from(name)], ['同名.png', Buffer.from([0,13,10,i])]]) {
   await fs.writeFile(path.join(dir,file), bytes);
   await git.add({...repo,filepath:file});
  }
  heads.push(await git.commit({...repo, author:{name:'Test', email:'test@example.invalid'}, message:name, disallowEmpty:true}));
 }
 await fs.rename(path.join(root,'光学 研究'), path.join(root,'新位置'));
 for (const [i,name] of ['新位置','量子计算'].entries()) {
  const dir = path.join(root,name);
  assert.equal(read(dir,'rev-parse','HEAD').toString().trim(), heads[i]);
  assert.deepEqual(read(dir,'show','HEAD:同名.png'), Buffer.from([0,13,10,i]));
  assert.deepEqual(read(dir,'show','HEAD:同名.md'), Buffer.from(i ? '量子计算' : '光学 研究'));
 }
});
