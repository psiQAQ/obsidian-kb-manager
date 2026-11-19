import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import { GutterMarker, ViewPlugin, gutter } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { editorInfoField, moment } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { ageColor, displayAuthor, lineCredits } from '../git/authorship.ts';
import type { LineCredit } from '../git/authorship.ts';
import type { GitPreferences } from '../preferences.ts';
import { gitDisabled } from './device.ts';

class CreditMarker extends GutterMarker {
	constructor(readonly label: string, readonly title: string, readonly background: string, readonly color: string) { super(); }
	eq(other: CreditMarker) {
		return this.label === other.label && this.title === other.title && this.background === other.background && this.color === other.color;
	}
	toDOM(view: EditorView) {
		const el = view.dom.ownerDocument.createElement('span');
		el.textContent = this.label || ' '; el.title = this.title;
		el.style.backgroundColor = this.background; el.style.color = this.color;
		return el;
	}
}

const emptyMarkers = RangeSet.of<GutterMarker>([]);
const replace = StateEffect.define<RangeSet<GutterMarker>>();
const markers = StateField.define<RangeSet<GutterMarker>>({
	create: () => emptyMarkers,
	update(value,tr) {
		for (const effect of tr.effects) if (effect.is(replace)) return effect.value;
		return tr.docChanged ? emptyMarkers : value;
	},
});

function formatDate(credit: LineCredit, prefs: GitPreferences, locale: string) {
	const date = moment.unix(credit.timestamp).locale(locale);
	if (prefs.blameTimezone === 'author') date.utcOffset(credit.offset);
	if (prefs.blameTimezone === 'utc') date.utc();
	switch (prefs.blameDate) {
		case 'hidden': return '';
		case 'date': return date.format('YYYY-MM-DD');
		case 'datetime': return date.format('YYYY-MM-DD HH:mm');
		case 'relative': return date.fromNow();
		case 'custom': return date.format(prefs.blameFormat);
	}
}

const subscriptions = new WeakMap<KnowledgeBaseManager, Set<() => void>>();
export function refreshAuthorship(plugin: KnowledgeBaseManager) {
	for (const notify of subscriptions.get(plugin) ?? []) notify();
}

export function registerAuthorship(plugin: KnowledgeBaseManager) {
	const watchers = new Set<() => void>();
	subscriptions.set(plugin,watchers);
	const controller = ViewPlugin.fromClass(class {
		private revision = 0;
		private timeout?: number;
		private pending = false;
		private running = false;
		private file?: string;
		constructor(private view: EditorView) {
			watchers.add(this.schedule); this.schedule();
		}
		update(change: ViewUpdate) {
			const file = change.state.field(editorInfoField,false)?.file?.path;
			if (change.docChanged || change.viewportChanged || file !== this.file) this.schedule();
		}
		schedule = () => {
			this.file = this.view.state.field(editorInfoField,false)?.file?.path;
			this.revision++;
			this.pending = true;
			window.clearTimeout(this.timeout);
			this.timeout = window.setTimeout(() => { void this.run(); },500);
		};
		private async run() {
			if (this.running || !this.pending) return;
			this.running = true; this.pending = false;
			const revision = this.revision;
			const view = this.view;
			let eligible = false;
			const set = (next: RangeSet<GutterMarker>) => {
				if (revision === this.revision && watchers.has(this.schedule) && next !== view.state.field(markers))
					view.dispatch({effects:replace.of(next)});
			};
			try {
				const file = this.file;
				const parent = file && plugin.config.parents.find(p => file.startsWith(p + '/'));
				if (!file || !parent || gitDisabled(plugin)) { set(emptyMarkers); return; }
				const pieces = file.slice(parent.length+1).split('/');
				if (pieces.length < 2) { set(emptyMarkers); return; }
				const location = parent + '/' + pieces[0];
				const known = Object.keys(plugin.known).find(id => plugin.known[id] === location);
				if (!plugin.preferences(known).lineAuthor && (known || !Object.values(plugin.prefs.libraries).some(p => p.lineAuthor))) {
					set(emptyMarkers); return;
				}
				const lib = (await discover(plugin.disk,plugin.config)).find(l => l.location === location);
				if (!lib?.identity || lib.problem || lib.duplicate || lib.git !== 'local') { set(emptyMarkers); return; }
				const prefs = plugin.preferences(lib.identity.id);
				if (!prefs.lineAuthor || revision !== this.revision) { set(emptyMarkers); return; }
				eligible = true;
				const doc = view.state.doc;
				const lastContentLine = doc.lines - (doc.line(doc.lines).length === 0 ? 1 : 0);
				const first = doc.lineAt(view.viewport.from).number;
				const last = Math.min(lastContentLine,doc.lineAt(view.viewport.to).number);
				if (last < first) { set(emptyMarkers); return; }
				const dir = await plugin.disk.path(location);
				const credits = await lineCredits(dir,pieces.slice(1).join('/'),first,last,doc.toString(),prefs);
				if (revision !== this.revision) return;
				await recheck(plugin.disk,plugin.config,lib);
				const now = Date.now();
				const ranges = credits.filter(c => c.line >= first && c.line <= last).map(c => {
					const label = [prefs.blameHash && c.oid.slice(0,8),displayAuthor(c.author,prefs.blameAuthor),
						formatDate(c,prefs,plugin.t('zh-cn','en'))].filter(Boolean).join(' · ');
					return new CreditMarker(label,[c.author,c.oid,c.summary].join(' · '),ageColor(c,prefs,now),prefs.blameText)
						.range(doc.line(c.line).from);
				});
				set(RangeSet.of(ranges,true));
			} catch (error) {
				if (eligible && revision === this.revision) {
					const explanation = plugin.t('无法载入行作者','Could not load line authors') + ' · ' + String(error);
					const marker = new CreditMarker('!',explanation,'transparent','var(--text-warning)');
					set(RangeSet.of([marker.range(view.state.doc.lineAt(view.viewport.from).from)]));
				} else set(emptyMarkers);
			} finally {
				this.running = false;
				if (this.pending && watchers.has(this.schedule)) this.schedule();
			}
		}
		destroy() {
			this.revision++; this.pending = false;
			window.clearTimeout(this.timeout);
			watchers.delete(this.schedule);
		}
	});
	plugin.registerEditorExtension([markers,controller,gutter({
		class:'kb-manager-author-gutter', markers:view => view.state.field(markers),
	})]);
	plugin.register(() => { watchers.clear(); subscriptions.delete(plugin); });
}
