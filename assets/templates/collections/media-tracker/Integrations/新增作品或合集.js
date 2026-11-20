/* QuickAdd User Script */
module.exports = async ({ app, quickAddApi }) => {
	const active = app.workspace.getActiveFile();
	const root = active?.parent?.path;
	if (active?.name !== "README.md" || !root || root === "/" || !app.vault.getAbstractFileByPath(root + "/Views/Media.base")) {
		throw new Error("请先打开媒体体验记录的本库首页。");
	}
	const categories = { 电影:"movie", 剧集:"series", 图书:"book", 游戏:"game", 播客:"podcast", 合集:"collection" };
	const choice = await quickAddApi.suggester(Object.keys(categories), Object.keys(categories));
	if (!choice) return;
	const title = (await quickAddApi.inputPrompt("标题"))?.trim();
	if (!title) return;
	if (/^[.]|[.]$|[<>:"/\\|?*]|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[.]|$)/iu.test(title) || Array.from(title).some(char => char.charCodeAt(0) < 32)) {
		throw new Error("标题含不支持的文件名字符。");
	}
	const collection = choice === "合集";
	const directory = root + (collection ? "/Collections" : "/Media");
	const path = directory + "/" + title + ".md";
	if (app.vault.getAbstractFileByPath(path)) throw new Error("本库已有同名条目。");
	const template = app.vault.getAbstractFileByPath(root + (collection ? "/Templates/媒体合集.md" : "/Templates/媒体作品.md"));
	if (!template || template.extension !== "md") throw new Error("找不到本库页面模板。");
	const body = (await app.vault.read(template)).replace(/\{\{title\}\}/gu, () => title);
	const content = collection ? body : body.replace(/^medium: ""$/mu, "medium: " + categories[choice]);
	if (!app.vault.getAbstractFileByPath(directory)) await app.vault.createFolder(directory);
	const file = await app.vault.create(path, content);
	await app.workspace.getLeaf().openFile(file);
};
