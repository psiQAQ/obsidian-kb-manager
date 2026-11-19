// Exercise the shipped entry point in a WebView-like realm without Node globals.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../main.js',import.meta.url),'utf8');
const commands = new Set(), secrets = new Map(), device = new Map();
class Plugin {
	loadData(){return null;}
	registerView(){}
	addSettingTab(){}
	addRibbonIcon(){}
	addCommand(command){commands.add(command.id);}
}
const obsidian = {Platform:{isMobile:true},Plugin,Modal:class {},ItemView:class {},PluginSettingTab:class {},
	getLanguage:()=>'en'};
const context = vm.createContext({
	module:{exports:{}}, TextEncoder,TextDecoder,URL,URLSearchParams,crypto:webcrypto,
	setTimeout,clearTimeout,atob,btoa,console,
	require(id){assert.equal(id,'obsidian','Unexpected mobile dependency: '+id);return obsidian;},
});
vm.runInContext(source,context,{filename:'main.js'});
const mobile = new context.module.exports();
mobile.app={vault:{adapter:{},configDir:'.qa-config'},
	loadLocalStorage:key=>device.get(key),saveLocalStorage:(key,value)=>device.set(key,value),
	secretStorage:{getSecret:key=>secrets.get(key),setSecret:(key,value)=>secrets.set(key,value)}};
mobile.manifest={id:'knowledge-base-manager'};
await mobile.onload();
assert.ok(commands.has('open-manager'));
assert.ok(commands.has('create-library'));
mobile.setDeviceAuthor('Mobile QA','mobile@example.invalid');
assert.equal(mobile.deviceAuthor().email,'mobile@example.invalid');
assert.ok(![...device.values()].includes('mobile@example.invalid'));
process.stdout.write('Mobile production entry loaded without Node, Electron or a native Git executable.\n');
