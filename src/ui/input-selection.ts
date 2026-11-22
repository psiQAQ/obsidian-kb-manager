export function captureInputSelection(input?: HTMLInputElement | HTMLTextAreaElement | null) {
	if (!input || input.doc.activeElement !== input) return;
	const {value,selectionStart,selectionEnd,selectionDirection,scrollTop}=input;
	return {
		value,
		restore(next:HTMLInputElement | HTMLTextAreaElement | null) {
			const {activeElement,body}=input.doc;
			if(!next?.isConnected || next.value!==value || (activeElement!==body && activeElement!==input))return;
			next.focus({preventScroll:true});
			if(selectionStart!==null && selectionEnd!==null)next.setSelectionRange(selectionStart,selectionEnd,selectionDirection ?? undefined);
			next.scrollTop=scrollTop;
		},
	};
}
