let nextPanelTabsId = 0;

export function createPanelTabs<T extends string>(
	container: HTMLElement,
	label: string,
	tabs: readonly {id: T; label: string}[],
	initialId?: T,
	onChange?: (id: T) => void,
) {
	const defaultId = tabs[0]?.id;
	if (defaultId === undefined) throw new Error('At least one tab is required');

	const groupId = 'kb-panel-tabs-' + ++nextPanelTabsId;
	const tabList = container.createDiv({cls: 'kb-panel-tabs', attr: {role: 'tablist', 'aria-label': label}});
	const panels = {} as Record<T, HTMLElement>;
	const buttons = {} as Record<T, HTMLButtonElement>;
	let active = initialId ?? defaultId;
	if (!tabs.some(tab => tab.id === active)) active = defaultId;

	function activate(id: T) {
		if (active === id) return;
		buttons[active].tabIndex = -1;
		buttons[active].setAttribute('aria-selected', 'false');
		panels[active].hidden = true;
		active = id;
		buttons[id].tabIndex = 0;
		buttons[id].setAttribute('aria-selected', 'true');
		panels[id].hidden = false;
		onChange?.(id);
	}

	for (const [index, tab] of tabs.entries()) {
		const {id, label: text} = tab;
		const tabId = groupId + '-tab-' + index, panelId = groupId + '-panel-' + index;
		const button = tabList.createEl('button', {
			cls: 'kb-panel-tab', text,
			attr: {type: 'button', id: tabId, role: 'tab', 'aria-controls': panelId, 'aria-selected': String(active === id)},
		});
		button.tabIndex = active === id ? 0 : -1;
		buttons[id] = button;
		const panel = container.createDiv({
			cls: 'kb-tab-panel',
			attr: {id: panelId, role: 'tabpanel', 'aria-labelledby': tabId, tabindex: '0'},
		});
		panel.hidden = active !== id;
		panels[id] = panel;

		button.addEventListener('click', () => {
			activate(id);
			button.focus();
		});
		button.addEventListener('keydown', event => {
			if (event.altKey || event.ctrlKey || event.metaKey) return;
			let next: number;
			switch (event.key) {
			case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
			case 'ArrowRight': next = (index + 1) % tabs.length; break;
			case 'Home': next = 0; break;
			case 'End': next = tabs.length - 1; break;
			default: return;
			}
			event.preventDefault();
			const nextId = tabs[next]!.id;
			activate(nextId);
			buttons[nextId].focus();
		});
	}
	return {panels, activate, getActive: () => active, focusActive: () => buttons[active].focus()};
}
