import {isMap,isScalar,isSeq,parseDocument} from 'yaml';

export function canvasFileFields(text:string){
	const canvas:unknown=JSON.parse(text.replace(/^\uFEFF/u,''));
	if(!canvas || typeof canvas!=='object' || Array.isArray(canvas) || 'nodes' in canvas && !Array.isArray(canvas.nodes))
		throw new Error('Invalid Canvas nodes');
	const doc=parseDocument(text,{schema:'json'});
	if(doc.errors.length)throw new Error('Ambiguous Canvas document');
	if(!('nodes' in canvas))return [];
	const nodes=doc.get('nodes',true);
	if(!isSeq(nodes))throw new Error('Invalid Canvas nodes');
	return nodes.items.flatMap((node,index)=>{
		if(!isMap(node) || node.get('type')!=='file')return [];
		const file=node.get('file',true), id=node.get('id');
		return [{field:`nodes[${index}].file`,id:typeof id==='string'?id:undefined,
			...(isScalar(file) && typeof file.value==='string' && file.range ? {
				token:{offset:file.range[0],original:text.slice(file.range[0],file.range[1]),target:file.value},
			} : {})}];
	});
}
