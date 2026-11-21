<script lang="ts">
    // Adapted from Obsidian Git 2.43.0 fileComponent and stagedFileComponent.
    // Copyright (c) 2020 Vinzent03, Denis Olehov. MIT, see assets/licenses/obsidian-git.txt.
    import { setIcon } from 'obsidian';
    interface RowAction { label: string; icon: string; run: () => void }
    interface Props {
        path: string; label: string; status: string; description: string; partial?: string; diffLabel: string;
        showDiff: () => void; actions: RowAction[];
    }
    let {path, label, status, description, partial, diffLabel, showDiff, actions}: Props = $props();
    function icon(node: HTMLElement, name: string) {
        setIcon(node,name);
        return {update(next: string) {setIcon(node,next);}};
    }
</script>

<div class="tree-item nav-file">
    <div class="tree-item-self nav-file-title kb-workspace-file" data-path={path}>
        <button type="button" class="tree-item-inner nav-file-title-content clickable-icon" aria-label={`${diffLabel} · ${path}`}
            title={`${diffLabel} · ${path}`} onclick={showDiff}>{label}</button>
        <div class="kb-workspace-file-actions">
            <span class="nav-file-tag" aria-label={description} title={description}>{status}</span>
            {#each actions as action (action.icon)}
                <button type="button" class="clickable-icon" aria-label={`${action.label} · ${path}`} title={action.label}
                    use:icon={action.icon} onclick={action.run}></button>
            {/each}
        </div>
        {#if partial}<span class="kb-partially-staged">{partial}</span>{/if}
    </div>
</div>
