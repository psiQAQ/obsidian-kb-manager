import { parse } from 'smol-toml';
import { tr } from '../i18n.ts';
import { gitResult } from './network-native.ts';

export async function assertPrivateManifestTree(dir:string, tree:string) {
	const entry=(await gitResult(dir,['ls-tree','-z',tree,'--','kb.toml'])).stdout.toString();
	if(!entry)return;
	const blob=/^100(?:644|755) blob ([a-f0-9]+)\tkb\.toml\0$/u.exec(entry);
	if(!blob)throw new Error(tr('请检查已跟踪的 kb.toml 文件类型','Review the tracked kb.toml file type'));
	const manifest=parse((await gitResult(dir,['cat-file','blob',blob[1]!])).stdout.toString('utf8'));
	if(manifest.manager!==undefined || manifest.preferences!==undefined)
		throw new Error(tr('Git 中含有本地 kb.toml 清单。请检查暂存区和提交历史。','Git contains the local kb.toml manifest. Review the index and commit history.'));
}

export async function assertPrivateManifestHistory(dir:string, head:string) {
	// A new push URL can receive old commits even when a tracking ref already exists.
	const commits=(await gitResult(dir,['rev-list','--full-history',head,'--','kb.toml'])).stdout.toString().trim();
	for(const commit of commits.split(/\s+/u).filter(Boolean))await assertPrivateManifestTree(dir,commit);
}
