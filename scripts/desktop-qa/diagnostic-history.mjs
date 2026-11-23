import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pluginId} from '../desktop-qa-host.mjs';

export async function verifyDiagnosticHistory({fixture,scenario,observe,modalButton,libraryMenu,evaluate}){
	await scenario('diagnosticHistory',async()=>{
		await libraryMenu('Alpha','Check library');
		await observe('select manifest check',()=>{
			const modal=document.querySelector('.modal.kb-v3-health'),select=modal?.querySelector('select');
			if(!select)return;
			select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}));
			const checkbox=[...modal.querySelectorAll('.kb-v3-check-choice')].find(row=>row.textContent.includes('Manifest and registration'))?.querySelector('input');
			if(!checkbox)return;
			if(!checkbox.checked)checkbox.click();
			const bases=[...modal.querySelectorAll('.kb-v3-check-choice')].find(row=>row.textContent.includes('Bases'))?.querySelector('input');
			if(!bases)return;
			if(!bases.checked)bases.click();return true;
		});
		async function verifyAccordion(){
			await evaluate(async()=>{
				const report=[...document.querySelectorAll('.modal .kb-v3-results')].find(el=>el.checkVisibility());
				const rows=[...report.querySelectorAll('.kb-check-result')];
				if(rows.length!==2)throw Error('Expected two check results');
				rows[0].parentElement.open=true;
				for(const row of rows){
					row.querySelector('summary').click();
					await new Promise(resolve=>row.addEventListener('toggle',resolve,{once:true}));
					if(rows.filter(r=>r.open).length!==1 || !row.querySelector('.kb-check-body')?.checkVisibility())
						throw Error('The selected result should be the only open panel');
				}
				if(!['checks','Paths excluded from scanning','Global filter','List.base','file.ext == "md"'].every(text=>rows[1].innerText.includes(text)))
					throw Error('Missing readable coverage details');
				rows[1].querySelector('summary').click();
				if(rows.some(r=>r.open))throw Error('Re-selecting the same check should collapse it');
			});
		}
		for(let count=0;count<2;count++){
			if(count===1)await modalButton('Choose checks again');
			await modalButton('Start check');
			await observe('completed manifest report',()=>document.querySelector('.kb-v3-check-output')?.innerText.includes('Passed'));
			await verifyAccordion();
		}
		await modalButton('History');
		await modalButton('View report');
		await observe('fresh report',()=>document.querySelector('.modal.kb-v3-health')?.textContent.includes('Recorded library inputs are current'));
		await verifyAccordion();
		const logs=join(fixture.vault,'Alpha','.log');
		const reports=[];
		for(const file of await readdir(logs)){
			if(!file.endsWith('.json'))continue;
			const report=JSON.parse(await readFile(join(logs,file),'utf8'));
			assert.equal(report.checks[0].rule.engine,'bundled');assert(report.inputVersion.fingerprint);
			reports.push(report.runId);
		}
		assert.equal(reports.length,2);
		await observe('comparison across successful runs',()=>{
			const details=[...document.querySelectorAll('.modal details')].find(el=>el.firstElementChild?.textContent==='Compare with an earlier report');
			if(!details)return;
			details.open=true;
			return ['New · 0','Resolved · 0','Still present · 0'].every(text=>details.innerText.includes(text));
		});
		await evaluate(async()=>{const file=window.app.vault.getFileByPath('Alpha/kb.toml');await window.app.vault.process(file,text=>text+'\n# QA edit\n');});
		await modalButton('Verify current files');
		await observe('stale history after input change',()=>document.querySelector('.modal.kb-v3-health')?.textContent.includes('Report is stale.'));
		const current=createHash('sha256').update(await readFile(join(fixture.vault,'Alpha','kb.toml'))).digest('hex');
		await observe('reloaded library manifest after history check',(id,signature)=>window.app.plugins.getPlugin(id).catalog.some(lib=>lib.location==='Alpha' && lib.signature===signature),pluginId,current);
		await evaluate(()=>document.querySelector('.modal.kb-v3-health :is(.modal-header-button,.modal-close-button)').click());
		return {reports,engine:'bundled',freshBeforeEdit:true,staleAfterEdit:true,exclusiveAccordion:true,readableBaseDetails:true};
	});
}
