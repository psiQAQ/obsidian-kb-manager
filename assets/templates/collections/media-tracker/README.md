# 媒体体验记录

打开 [远岸电台](./Media/远岸电台.md)，修改进度和评分。作品页的 `collections` 采用链接列表；填入 [短篇声音故事](./Collections/短篇声音故事.md) 后，合集会自动列出作品。录入时用 `medium` 区分电影、剧集、图书、游戏、播客等，`unit` 记录以页、集、分钟等哪种单位计数。

启用 [Dataview](https://obsidian.md/plugins?id=dataview)、[Meta Bind](https://obsidian.md/plugins?id=obsidian-meta-bind-plugin) 和 [QuickAdd](https://obsidian.md/plugins?id=quickadd)。Dataview 的普通查询展示合集和年度汇总，Meta Bind 在作品页更新状态和进度。

在 QuickAdd 设置中新增 Macro，把本库 `Integrations/新增作品或合集.js` 作为 **User Script** 步骤，自行命名并启用命令。每次打开本库首页后运行该 Macro，选择作品类型或合集，输入标题。也可手动建页并插入本库的模板。

## 作品

![[{{kb_root}}/Views/Media.base]]

## 年度完成记录

```dataview
TABLE WITHOUT ID key AS "年份", length(rows) AS "完成作品"
FROM "{{kb_root}}/Media"
WHERE type = "media-item" AND status = "completed" AND finished
GROUP BY dateformat(date(finished), "yyyy")
SORT key DESC
```

[来源与许可](./LICENSES.md) · [检查示例](./Examples/Checks.md)
