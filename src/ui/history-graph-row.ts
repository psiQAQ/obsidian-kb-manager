import type { GraphRow } from '../git/history-graph.ts';
import { historyTrackColors } from '../git/history-graph.ts';
import { historyRowHeight } from './history-window.ts';

/** Continue the same tracks through adjacent rows; edge coordinates use lane units. */
export function drawCommitGraph(row:HTMLElement,item:GraphRow,tooltip:string,node:'commit'|'merge'|'head'|'worktree'|'stash') {
	const spacing=15;
	const x=(lane:number)=>8+spacing*lane;
	const svg=row.createSvg('svg',{cls:'kb-history-graph',attr:{
		height:historyRowHeight,'aria-hidden':'true',
	}});
	const trackClass=(color:number)=>'kb-track-'+color%historyTrackColors;
	const path=(d:string,color:number)=>svg.createSvg('path',{cls:trackClass(color),attr:{d}});
	for(const {from,to,color} of item.rails)
		path('M '+x(from)+' 0 C '+x(from)+' 16 '+x(to)+' 16 '+x(to)+' 32',color);
	if(item.incoming)path('M '+x(item.lane)+' 0 V 16',item.color);
	for(const {to,color,startColor} of item.parents){
		const fromX=x(item.lane),toX=x(to);
		if(startColor===undefined)path(`M ${fromX} 16 C ${fromX} 24 ${toX} 24 ${toX} 32`,color);
		else{
			const midX=(fromX+toX)/2;
			path(`M ${fromX} 16 C ${fromX} 20 ${(fromX+midX)/2} 22 ${midX} 24`,startColor);
			path(`M ${midX} 24 C ${(midX+toX)/2} 26 ${toX} 28 ${toX} 32`,color);
		}
	}
	const marker=svg.createSvg('circle',{cls:[trackClass(item.color),'kb-history-node-'+node],
		attr:{cx:x(item.lane),cy:16,r:node==='merge' || node==='head'?5:4}});
	marker.createSvg('title').textContent=tooltip;
}
