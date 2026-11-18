// Adapted from Obsidian Git's editor/conflicts/model.ts (MIT).
export type ConflictChoice='ours'|'base'|'theirs'|'both';
export interface ConflictBlock {
	from:number; to:number; headingEnd:number; ours:string; base?:string; theirs:string;
}

export function parseConflictBlocks(text:string):ConflictBlock[]{
	const blocks:ConflictBlock[]=[];
	let start:RegExpMatchArray|undefined, base:RegExpMatchArray|undefined, split:RegExpMatchArray|undefined;
	let depth=0,valid=false;
	const markers=/^(<{7}|\|{7}|={7}|>{7})(?:[ \t][^\r\n]*)?\r?(?:\n|$)/gmu;
	for(const marker of text.matchAll(markers)){
		const kind=marker[1]![0];
		if(kind==='<'){
			if(depth===0){start=marker;base=undefined;split=undefined;valid=true;}
			else valid=false;
			depth++;
			continue;
		}
		if(!depth || !start)continue;
		if(kind==='>'){
			depth--;
			if(depth===0 && valid && split){
				const beginning=start.index!,headingEnd=beginning+start[0].length;
				blocks.push({from:beginning,to:marker.index+marker[0].length,
					headingEnd:headingEnd-(start[0].endsWith('\r\n')?2:start[0].endsWith('\n')?1:0),
					ours:text.slice(headingEnd,(base ?? split).index),
					base:base ? text.slice(base.index!+base[0].length,split.index) : undefined,
					theirs:text.slice(split.index!+split[0].length,marker.index)});
			}
		}else if(kind==='|'){
			if(base || split)valid=false;
			base=marker;
		}else{
			if(split)valid=false;
			split=marker;
		}
	}
	return blocks;
}

export function resolveBlock(block:ConflictBlock,choice:ConflictChoice):string{
	if(choice==='both')return block.ours+block.theirs;
	if(choice==='base' && block.base===undefined)throw new Error('Two-way conflict has no base section');
	return block[choice]!;
}
