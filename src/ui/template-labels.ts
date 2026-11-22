import {tr} from '../i18n.ts';
import type {PackDescriptor} from '../kb/template-pack.ts';

const englishLabels = new Map<string, readonly [string,string]>([
	['minimal-first-week',['First week of notes','Get started with notes and backlinks using a short guide and one note a day.']],
	['minimal-journal',['Journal and knowledge notes','Record each day in a journal and link ideas in notes organized by year.']],
	['kepano',['Kepano (with examples)','Collect books, media, people, places, web clippings and daily notes using category properties.']],
	['media-tracker',['Media tracker','Track progress, ratings, impressions and collections for books, films and music.']],
	['research-project',['Research project','Connect research questions, source material, logs and interim findings.']],
	['research-evidence',['Research evidence map','Organize analysis across sources with author pages, source pages, individual findings and topics.']],
	['zettelkasten',['Zettelkasten','Turn fleeting notes and reading annotations into permanent notes and connect them with structure notes.']],
	['domain-reading',['Topic reading and spaced review','Plan reading by topic and turn key terms into questions for spaced review.']],
	['coursework',['Coursework','Organize classes, handouts, assignments and deadlines by course.']],
	['exam-practice',['Exam practice and error review','Practice questions by topic and record mistakes and the results of each retry.']],
	['knowledge-garden',['Knowledge garden','Develop quick ideas into practical notes you can share and revise.']],
	['technology-radar',['Technology radar','Record technology decisions and their evidence as assess, trial, adopt or hold.']],
	['project-review',['Projects and weekly reviews','Track tasks in project notes and record completed, recurring and archived work in weekly reviews.']],
	['gtd',['Action lists and GTD','Process an inbox into next actions, waiting items and recurring tasks.']],
	['manuscript',['Long-form manuscript','Outline a manuscript and draft and revise its chapters in separate notes.']],
	['worldbuilding',['Worldbuilding and timelines','Link characters, places, factions and events to build a world you can query.']],
	['llm-wiki',['Integrated LLM Wiki','Preserve original sources and build traceable knowledge notes, indexes and activity logs.']],
	['ai-worklog',['AI collaboration work log','Use work cards, session handoffs and decision notes to continue human and AI work in the same library.']],
]);

export function builtinTemplateLabels(pack: PackDescriptor) {
	const english=englishLabels.get(pack.id);
	return english ? {name:tr(pack.name,english[0]),description:tr(pack.description,english[1])}
		: {name:pack.name,description:pack.description};
}

export function templateIdentityLabel(id:string) {
	if(id==='directory')return tr('目录模板','Folder template');
	if(id==='unknown')return tr('未知','Unknown');
	return id;
}
