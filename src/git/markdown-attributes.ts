/** Only the exact shipped LF policies may pass the repository guard. */
export const markdownAttributes = '.gitattributes text eol=lf\n*.md text eol=lf\n';
export const instanceAttributes=markdownAttributes+'*.base text eol=lf\n*.canvas text eol=lf\n/kb-template.json text eol=lf\n/checks/*.mjs text eol=lf\n';
export const attributePolicies=[markdownAttributes,instanceAttributes];
export const attributesPath = '.gitattributes';

export function builtinAttributesFile() {
	return {name:attributesPath,bytes:new TextEncoder().encode(instanceAttributes)};
}
