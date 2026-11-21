// Formatting helpers for the verified common rule protocol.
export const commonToolsSource = String.raw`
const addReason = (result, reason) => {
	if (result.reason?.includes(reason)) return false;
	result.reason = result.reason ? result.reason + ' ' + reason : reason;
	return true;
};
const validText = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
function commonTools(chinese) {
	const tr = (zh, en) => chinese ? zh : en;
	return {tr, addReason, validText};
}
`;
