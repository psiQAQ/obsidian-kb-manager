/** Only the exact shipped LF policies may pass the repository guard. */
const attributesLf = '.gitattributes text eol=lf\n';
export const markdownAttributes = attributesLf+'*.md text eol=lf\n';
export const instanceAttributes=markdownAttributes+'*.base text eol=lf\n*.canvas text eol=lf\n/kb-template.json text eol=lf\n/checks/*.mjs text eol=lf\n';
export const attributesPath = '.gitattributes';
const checkKitAttributes='/checks/kb-check.cjs text eol=lf\n/checks/common/*.mjs text eol=lf\n';
export const attributePolicies=[markdownAttributes,instanceAttributes,
	...([attributesLf,markdownAttributes,instanceAttributes].map(policy=>policy+checkKitAttributes))];

export function attributesWithCheckKit(previous:string|undefined) {
	if(previous===undefined)return attributesLf+checkKitAttributes;
	if(previous===markdownAttributes || previous===instanceAttributes)return previous+checkKitAttributes;
	return attributePolicies.includes(previous)?previous:undefined;
}

export function builtinAttributesFile() {
	return {name:attributesPath,bytes:new TextEncoder().encode(instanceAttributes)};
}
