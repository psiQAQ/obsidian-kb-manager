import { tr } from '../i18n.ts';
import type { AbstractTextComponent, Setting } from 'obsidian';

interface TextOptions {
	placeholder?: string;
	example?: string;
	numeric?: boolean;
}

export function addTextField(setting: Setting, value: string, change: (value: string) => void,
	options: TextOptions = {}, multiline = false) {
	const { example, placeholder, numeric } = options;
	const configure = (input: AbstractTextComponent<HTMLInputElement | HTMLTextAreaElement>) => {
		input.setPlaceholder(example ?? placeholder ?? '').setValue(value).onChange(change);
		const element = input.inputEl;
		element.setAttribute('aria-label', setting.nameEl.textContent ?? '');
		if (numeric) element.inputMode = 'numeric';
		if (!example) return;
		element.title = tr('字段为空时，按 Tab 填入并选中示例。', 'When this field is empty, press Tab to insert and select the example.');
		element.onkeydown = event => {
			if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || element.value !== '') return;
			event.preventDefault();
			input.setValue(example);
			change(example);
			element.select();
		};
	};
	if (multiline) return setting.setClass('kb-multiline-field').addTextArea(input => {
		input.inputEl.rows = 3;
		configure(input);
	});
	return setting.addText(configure);
}
