export interface HistorySelection {
	readonly anchor:string;
	readonly peer:string;
	readonly peerAsBase?:true;
}

export const closedHistorySelection:HistorySelection={anchor:'',peer:''};

export function activateHistorySelection(selection:HistorySelection,oid:string,action:'toggle'|'compare'|'navigate'):HistorySelection {
	if(selection.anchor===oid)return action==='navigate'?selection:closedHistorySelection;
	if(action==='compare' && selection.anchor)return {anchor:selection.anchor,peer:selection.peer===oid?'':oid};
	return {anchor:oid,peer:''};
}

export function validateHistorySelection(selection:HistorySelection,indexOf:(oid:string)=>number):HistorySelection {
	if(!selection.anchor || indexOf(selection.anchor)<0)return closedHistorySelection;
	if(selection.peer && indexOf(selection.peer)<0)return {anchor:selection.anchor,peer:''};
	return selection;
}

export function historyMenuSelection(target:string,origin:string,pinnedBase:string):HistorySelection {
	return origin===pinnedBase?{anchor:target,peer:''}:{anchor:target,peer:origin,peerAsBase:true};
}

export function historyGesture(selection:HistorySelection,indexOf:(oid:string)=>number) {
	if(!selection.peer)return undefined;
	const {anchor,peer}=selection;
	return !selection.peerAsBase && indexOf(anchor)>indexOf(peer)?{from:anchor,to:peer}:{from:peer,to:anchor};
}
