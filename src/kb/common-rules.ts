declare const KB_COMMON_RULES:Record<string,string>;
declare const KB_COMMON_DIGESTS:Record<string,string>;

export function commonRuleSources(){return typeof KB_COMMON_RULES==='undefined'?{}:KB_COMMON_RULES;}
export function commonRuleDigests(){return typeof KB_COMMON_DIGESTS==='undefined'?{}:KB_COMMON_DIGESTS;}
