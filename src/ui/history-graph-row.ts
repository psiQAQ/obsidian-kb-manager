import type { GraphRow } from '../git/history-graph.ts';

/** Continue the same tracks through adjacent rows; edge coordinates use lane units. */
export function drawCommitGraph(row:HTMLElement,item:GraphRow) {
	const spacing=15;
	const x=(lane:number)=>8+spacing*lane;
	const svg=row.createSvg('svg',{cls:'kb-history-graph',attr:{
		height:32,'aria-hidden':'true',
	}});
	const path=(d:string,color:number)=>svg.createSvg('path',{cls:'kb-track-'+color%6,attr:{d}});
	for(const {from,to,color} of item.rails)
		path('M '+x(from)+' 0 C '+x(from)+' 16 '+x(to)+' 16 '+x(to)+' 32',color);
	if(item.incoming)path('M '+x(item.lane)+' 0 V 16',item.color);
	for(const {to,color} of item.parents)
		path('M '+x(item.lane)+' 16 C '+x(item.lane)+' 24 '+x(to)+' 24 '+x(to)+' 32',color);
	svg.createSvg('circle',{cls:'kb-track-'+item.color%6,attr:{cx:x(item.lane),cy:16,r:4}});
}
