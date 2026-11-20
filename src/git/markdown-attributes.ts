/** This exact root file is the only Git attributes policy the plugin manages. */
export const markdownAttributes = '.gitattributes text eol=lf\n*.md text eol=lf\n';
export const attributesPath = '.gitattributes';

export function builtinAttributesFile() {
	return {name:attributesPath,bytes:new TextEncoder().encode(markdownAttributes)};
}
