declare module 'picomatch' {
	export default function picomatch(pattern:string,options:Record<string,boolean>):(input:string)=>boolean;
}
