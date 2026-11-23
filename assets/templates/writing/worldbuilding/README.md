# 世界观与时间线

每类实体都有独立模板。先建地点和阵营，再填人物的 `home`、`faction`，给事件填 `location` 和 `participants`。关联属性使用本库双链。事件的公历日期使用 `YYYY-MM-DD`。使用架空纪年时，可采用如「星历 42 年 6 月」的写法。

启用 [Dataview](https://obsidian.md/plugins?id=dataview) 即可生成索引，无需 JavaScript 查询。示例 [驿站换班](./Events/驿站换班.md) 展示如何从事件走到地点和角色。

## 设定实体

![[./Views/World.base]]

## 人物与阵营

```dataview
TABLE rows.file.link AS "人物", rows.role AS "角色"
FROM "{{kb_root}}/Characters"
WHERE type = "world-character"
GROUP BY faction AS "阵营"
```

## 事件先后

```dataview
TABLE start AS "开始", end AS "结束", location AS "地点", participants AS "参与者"
FROM "{{kb_root}}/Events"
WHERE type = "world-event"
SORT start ASC
```

[来源与许可](./LICENSES.md) · [检查示例](./Examples/Checks.md)
