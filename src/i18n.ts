let chinese = true;
let configured = false;

export function setLanguage(locale: string) {
	configured = true;
	chinese = /^zh(?:[-_]|$)/i.test(locale);
}

export function tr(zh: string, en: string): string {
	return chinese ? zh : en;
}

export function fromEnglish(en:string,zh:string) {
	return configured ? tr(zh,en) : en;
}
