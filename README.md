# Knowledge Base Manager

Manage several knowledge bases in one Obsidian vault, each with its own templates, diagnostics, and Git history. For example, you can commit changes to a research project while leaving your reading notes untouched. Start with an empty vault or register folders you already use.

[简体中文使用指南](README.zh-CN.md)

## Install on desktop

Use Obsidian 1.15.1 or later. Install Git for repository operations and Node.js to run a new library’s diagnostic rules in Obsidian or from the command line.

In **Settings → Community plugins → Browse**, search for **Knowledge Base Manager**, then select **Install** and **Enable**. You can also open the plugin directly from the [Obsidian community directory](https://community.obsidian.md/plugins/knowledge-base-manager).

For a manual installation from GitHub:

1. Open the release you want and download `main.js`, `manifest.json`, and `styles.css` from **Assets**. [GitHub Releases](https://github.com/psiQAQ/obsidian-kb-manager/releases/latest)
2. Create a folder named `knowledge-base-manager` under `<vault>/.obsidian/plugins/` and place all three files directly inside it. If your vault uses a different configuration folder, substitute that folder for `.obsidian`.
3. Reload Obsidian and enable **Knowledge Base Manager** under **Settings → Community plugins**.

## Create your first library

1. Run **Open knowledge base manager** from the command palette. In the sidebar, select **New**.
2. Choose a use case and a template. The 18 built-in templates cover research, reading, project management, writing, and other workflows. [Template catalog and upstream credits](docs/template-catalog.md)
3. Choose the vault root or another parent folder, enter the library folder name, and review the Git identity. You can change the initial branch and commit message. Leave the remote URL blank to work locally.
4. Review the files and the template’s suggested folders to exclude from Obsidian search. Clear any exclusions you do not want, then confirm. With the defaults, the first commit is `Initial commit` on `main`.

Open a note in the library to insert one of its page templates. In the sidebar you can review file changes, stage a file or a hunk, and commit to that library. To work with an existing library, use **Registry** to preview its registration. Each instance carries its own `kb.toml` identity file.

Registered paths are stored in the plugin’s `data.json` alongside its language and Git defaults. If your vault is in Git, check whether `data.json` is already tracked before sharing it. It now contains your library folder names.

## Check a library

Open **… → Check library** on the library’s row. You can check properties, links, attachments, Canvas files, and Bases, or run the checks declared by its template. Select **Portability** separately to find dependencies on other libraries and inspect same-name link targets. The desktop plugin uses Obsidian’s link resolution to identify the file that actually opens.

Each result includes findings and coverage. A partial result means something could not be checked, even if there are no findings. New libraries carry their own runner and editable rules. From the library root, with Node.js installed, run:

```sh
node ./checks/kb-check.cjs --library . --checks all
```

For libraries created before 3.2.0, **Export offline check tool** remains available. Review changes to local rules before trusting them in Obsidian. These scripts execute with your account’s permissions.

The CLI writes JSON to standard output. Read `status`, each check’s `coverage`, and its `diagnostics` together. Offline checks can report a short link as unverified when its actual destination depends on Obsidian’s metadata cache.

## Files, processes, and privacy

| Capability | When it is used |
| --- | --- |
| Filesystem access | Creating and moving a library, reading its Git metadata, and saving diagnostic logs in its `.log/` folder require direct access to local files. The desktop plugin uses Node.js filesystem APIs to check paths and filesystem links before managed operations. |
| Local processes | The plugin starts system Git for repository operations and OpenSSH for SSH connections. It selects executables outside the vault and passes arguments directly when starting a process. Library-owned common and template-specific checks run in a separate local Node.js process with your operating-system account’s file and network permissions. Built-in checks are identified by their bundled fingerprints. For personal scripts, review the source and approve its SHA-256 fingerprint before running it. |
| Vault paths and note contents | Select a manifest by path or scan a folder to register libraries. Portability checks look for same-name candidates in the current and registered libraries by default. Choose the whole-vault option to include other folders. Obsidian resolves actual link destinations across the vault in both modes. |
| Diagnostic JSON | Open the report or debug information to inspect the JSON. You can select the text and use your system’s Copy command. |
| Network and credentials | Git clone, fetch, pull, and push contact the remote you configure. A push sends the library’s commits, including their author information. Automatic sync requires authorization for that library. Desktop Git can use your system credential helper or SSH configuration. |

## Build and contribute

Use Node.js 24 and npm in the repository root. Run `npm ci`, then `npm run build` to generate `main.js` and `dist/kb-check.cjs`. To make a local ZIP with the plugin, CLI, and license notices, run `python scripts/package_plugin.py`. The archive is written to `dist/knowledge-base-manager.zip`.

The Chinese guides cover the [Git workflow](docs/library-git.md), [library lifecycle](docs/library-lifecycle.md), [diagnostic report format](docs/diagnostics.md), [template authoring](docs/template-authoring.md), and [build and verification commands](docs/development.md).

## License and credits

Knowledge Base Manager uses the [0BSD license](LICENSE). Its Git interface includes code adapted from [Obsidian Git 2.43.0](https://github.com/Vinzent03/obsidian-git) under the [MIT license](assets/licenses/obsidian-git.txt). Each built-in template credits its authors and records its upstream source and license in the [template catalog](docs/template-catalog.md).
