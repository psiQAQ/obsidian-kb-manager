import { FileSystemAdapter, Modal, Plugin } from 'obsidian';

export default class KnowledgeBaseManager extends Plugin {
 onload(): void {
  this.addCommand({
   id: 'open-manager',
   name: 'Open manager',
   callback: () => {
    const modal = new Modal(this.app);
    modal.setTitle('Knowledge base manager');
    modal.contentEl.setText(this.app.vault.adapter instanceof FileSystemAdapter
     ? 'Local knowledge base storage is available.'
     : 'A desktop filesystem vault is required.');
    modal.open();
   },
  });
 }
}
