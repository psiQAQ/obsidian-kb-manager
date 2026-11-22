// @ts-check

/**
 * @param {{
 *   app: import('obsidian').App,
 *   quickAddApi: {
 *     suggester: (labels: string[], values: string[]) => Promise<unknown>,
 *     inputPrompt: (label: string) => Promise<string | null | undefined>
 *   }
 * }} params
 */
module.exports = async ({ app, quickAddApi }) => {
	const active = app.workspace.getActiveFile();
	const root = active?.parent?.path;
	if (active?.name !== "README.md" || !root || root === "/" || !app.vault.getAbstractFileByPath(root + "/Views/Media.base")) {
		throw new Error("请先打开媒体体验记录的本库首页。");
	}
	const categories = new Map([
		["电影", "movie"], ["剧集", "series"], ["图书", "book"],
		["游戏", "game"], ["播客", "podcast"], ["合集", "collection"],
	]);
	const labels = [...categories.keys()];
	const choice = await quickAddApi.suggester(labels, labels);
	if (typeof choice !== "string") return;
	const medium = categories.get(choice);
	if (!medium) return;
	const title = (await quickAddApi.inputPrompt("标题"))?.trim();
	if (!title) return;
	if (/^[.]|[.]$|[<>:"/\\|?*]|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[.]|$)/iu.test(title) || Array.from(title).some(char => char.charCodeAt(0) < 32)) {
		throw new Error("标题含不支持的文件名字符。");
	}
	const collection = medium === "collection";
	const directory = root + (collection ? "/Collections" : "/Media");
	const path = directory + "/" + title + ".md";
	if (app.vault.getAbstractFileByPath(path)) throw new Error("本库已有同名条目。");
	const template = app.vault.getFileByPath(root + (collection ? "/Templates/媒体合集.md" : "/Templates/媒体作品.md"));
	if (!template) throw new Error("找不到本库页面模板。");
	const date = new Date();
	const localDate = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(value => String(value).padStart(2, "0")).join("-");
	const body = (await app.vault.read(template))
		.replace(/\{\{(?:title|kb_root|date)\}\}/gu, token =>
			token === "{{title}}" ? title : token === "{{kb_root}}" ? root : localDate);
	const content = collection ? body : body.replace(/^medium: ""$/mu, "medium: " + JSON.stringify(medium));
	if (!app.vault.getAbstractFileByPath(directory)) await app.vault.createFolder(directory);
	const file = await app.vault.create(path, content);
	await app.workspace.getLeaf().openFile(file);
};
