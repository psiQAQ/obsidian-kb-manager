import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

interface Scope { view?: string; expressions: ((root:string)=>string)[] }
const quote=(value:string)=>JSON.stringify(value);
const wiki=(root:string)=>'file.inFolder('+quote(root+'/wiki')+')';
const scopes: Scope[]=[
	{expressions:[root=>'this.file.path.startsWith('+quote(root+'/')+')',root=>'file.path.startsWith('+quote(root+'/')+')']},
	{view:'现行知识',expressions:[wiki]}, {view:'人工笔记',expressions:[root=>'file.inFolder('+quote(root+'/Notes')+')']},
	{view:'按类别浏览',expressions:[wiki]}, {view:'历史归档',expressions:[wiki]},
];

export function rebind(source:string,previous:string,destination:string) {
	const doc=parseDocument(source);
	if(doc.errors.length)throw new Error('Base YAML 无法解析：'+doc.errors[0]?.message);
	const edits: {start:number;end:number;old:string;value:string;role:string}[]=[];
	const manual:string[]=[];
	for(const scope of scopes){
		let conditions=doc.getIn(['filters','and'],true);
		if(scope.view){
			const views=doc.get('views',true);
			const matches=isSeq(views)?views.items.filter(item=>isMap(item) && item.get('name')===scope.view):[];
			const view=matches.length===1?matches[0]:undefined;
			conditions=isMap(view)?view.getIn(['filters','and'],true):undefined;
		}
		for(const expression of scope.expressions){
			const old=expression(previous), value=expression(destination);
			const nodes=isSeq(conditions)?conditions.items.filter(isScalar):[];
			const matches=nodes.filter(n=>n.value===old);
			if(matches.length!==1 || !matches[0]?.range){
				if(nodes.filter(n=>n.value===value).length!==1)manual.push((scope.view??'总过滤器')+'：'+old);
				continue;
			}
			if(old===value)continue;
			edits.push({start:matches[0].range[0],end:matches[0].range[1],old,value,role:scope.view??'总过滤器'});
		}
	}
	let content=source;
	for(const edit of [...edits].sort((a,b)=>b.start-a.start)){
		content=content.slice(0,edit.start)+JSON.stringify(edit.value)+content.slice(edit.end);
	}
	if(parseDocument(content).errors.length)throw new Error('更新绑定后 YAML 无效');
	return {content,edits,manual};
}
