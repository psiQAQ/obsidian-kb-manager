# 行动清单与 GTD

刚想到的输入用 **收件事项** 记录。澄清后明确是可做的 **行动**、需要他人回复的等待事项，还是要拆成多步的 **项目**。`status: next` 放入下一步行动。将等待事项放在 `Actions/` 下，设为 `status: waiting`，并填写有效的 `follow_up` 日期。

[整理资料清单](./Actions/整理资料清单.md) 是每周重复的活动。启用 [QuickAdd](https://obsidian.md/plugins?id=quickadd) 后创建 Macro，以 `Integrations/推进重复行动.js` 为 **User Script**，命名并启用命令。完成一次后，在该行动页运行命令。它按 `every` 从 `next` 推进一次并保持行动活动。`every` 可填 `1d`、`2w`、`1m` 或 `1y` 等。跨月当前日期不存在时使用目标月最后一天。

## 行动中心

![[./Views/Actions.base]]



[来源与许可](./LICENSES.md) · [检查示例](./Examples/Checks.md)
