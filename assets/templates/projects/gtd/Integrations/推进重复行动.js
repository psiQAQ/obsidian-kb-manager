// @ts-check

/** @param {{ app: import('obsidian').App }} params */
module.exports = async ({ app }) => {
	const file = app.workspace.getActiveFile();
	const root = file?.parent?.parent?.path;
	if (!root || file?.parent?.name !== "Actions" || !app.vault.getAbstractFileByPath(root + "/Views/Actions.base")) throw new Error("请打开本库 Actions 下的一条重复行动。");
	await app.fileManager.processFrontMatter(file, /** @param {Record<string, unknown>} properties */ properties => {
		if (properties.type !== "gtd-action" || properties.status !== "next") throw new Error("行动的状态应为 next。");
		const every = properties.every;
		const previous = properties.next;
		if (typeof every !== "string" || typeof previous !== "string") throw new Error("需要有效的 every 间隔和 next 日期。");
		const interval = /^([1-9]\d{0,2})([dwmy])$/u.exec(every);
		const date = new Date(previous + "T00:00:00Z");
		if (!interval || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== previous) throw new Error("需要有效的 every 间隔和 next 日期。");
		const count = Number(interval[1]);
		const unit = interval[2];
		if (unit === "d" || unit === "w") {
			date.setUTCDate(date.getUTCDate() + count * (unit === "w" ? 7 : 1));
		} else {
			const day = date.getUTCDate();
			date.setUTCDate(1);
			date.setUTCMonth(date.getUTCMonth() + count * (unit === "y" ? 12 : 1));
			const last = new Date(date);
			last.setUTCMonth(last.getUTCMonth() + 1, 0);
			date.setUTCDate(Math.min(day, last.getUTCDate()));
		}
		if (date.getUTCFullYear() > 9999) throw new Error("下一日期超出支持范围。");
		properties.next = date.toISOString().slice(0, 10);
	});
};
