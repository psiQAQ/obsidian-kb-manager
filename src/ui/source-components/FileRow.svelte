<script lang="ts">
    // Adapted from Obsidian Git 2.43.0 fileComponent and stagedFileComponent.
    // Copyright (c) 2020 Vinzent03, Denis Olehov. MIT, see assets/licenses/obsidian-git.txt.
    import { setIcon } from 'obsidian';
    interface RowAction { label: string; icon: string; run: () => void }
    interface Props {
        path: string; label: string; status: string; description: string;
        showDiff: () => void; actions: RowAction[];
    }
    let {path, label, status, description, showDiff, actions}: Props = $props();
    function icon(node: HTMLElement, name: string) {
        setIcon(node,name);
        return {update(next: string) {setIcon(node,next);}};
    }
</script>

<div class="tree-item nav-file">
    <div class="tree-item-self nav-file-title" data-path={path}>
        <button type="button" class="tree-item-inner nav-file-title-content clickable-icon" title={path} onclick={showDiff}>{label}</button>
        <span class="nav-file-tag" aria-label={description} title={description}>{status}</span>
        {#each actions as action (action.icon)}
            <button type="button" class="clickable-icon" aria-label={action.label} title={action.label}
                use:icon={action.icon} onclick={action.run}></button>
        {/each}
    </div>
</div>
