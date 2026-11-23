"""Build the offline install ZIP from the production bundle and its actual licenses."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
metadata = json.loads((ROOT / "dist/build-inputs.json").read_text(encoding="utf-8"))
allowed = {"obsidian", "@codemirror/view", "@codemirror/state", "crypto", "buffer", "process", "node:fs", "node:fs/promises",
           "node:child_process", "node:https", "node:http", "node:os", "node:path", "node:crypto", "node:timers/promises", "node:timers", "node:util"}
unexpected = {item["path"] for item in metadata["outputs"]["main.js"]["imports"]} - allowed
if unexpected:
    raise ValueError(f"Unverified runtime dependencies: {unexpected}")
if any(name.startswith("references/") for name in metadata["inputs"]):
    raise ValueError("Reference submodule included in bundle")
catalog = ROOT / "assets/templates"
notices = []
for path in sorted(catalog.glob("*/*/kb-template.json")):
    spec = json.loads(path.read_text(encoding="utf-8"))
    notices.append("## " + spec["name"] + "\n\n" + "\n".join(
        f'- {src["author"]} · {src["url"]} · {src["commit"]} · {src["license"]}' for src in spec["sources"]))
    for doc in sorted(path.parent.glob("LICENSE*")):
        notices.append(doc.read_text(encoding="utf-8"))
cli = json.loads((ROOT / "dist/cli-build-inputs.json").read_text(encoding="utf-8"))

notices.append((ROOT / "assets/licenses/obsidian-git.txt").read_text(encoding="utf-8"))
packages = set()
for name in set(metadata["inputs"]) | set(cli["inputs"]):
    if not name.startswith("node_modules/"):
        continue
    directory = (ROOT / name).parent
    while directory != ROOT and not (directory / "package.json").is_file():
        directory = directory.parent
    while directory != ROOT:
        spec = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        if spec.get("name") and spec.get("version"):
            packages.add(directory)
            break
        directory = directory.parent
        while directory != ROOT and not (directory / "package.json").is_file():
            directory = directory.parent

for directory in sorted(packages):
    spec = json.loads((directory / "package.json").read_text(encoding="utf-8"))
    licenses = sorted(p for p in directory.iterdir() if p.is_file() and
                      p.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")))
    if spec['name'] == 'clean-git-ref' and spec['license'] == 'Apache-2.0':
        licenses = [ROOT / "node_modules/typescript/LICENSE.txt"]
    if spec['name'] == 'diff3':
        notices.extend(["## diff3 " + spec['version'],
                        (directory / 'diff3.js').read_text().split('var onp', 1)[0],
                        (directory / 'onp.js').read_text().split('*/', 1)[0] + '*/'])
        continue
    if not licenses:
        raise ValueError(f"Review missing license for {spec['name']}")
    notices.append(f"## {spec['name']} {spec['version']}\n\n" +
                   "\n\n".join(p.read_text(encoding="utf-8-sig") for p in licenses))

files = {name: (ROOT / name).read_bytes() for name in ["main.js", "manifest.json", "LICENSE"]}
files["kb-check.cjs"] = (ROOT / "dist/kb-check.cjs").read_bytes()
if (ROOT / "styles.css").is_file():
    files["styles.css"] = (ROOT / "styles.css").read_bytes()
files["THIRD_PARTY_NOTICES.md"] = "\n\n".join(notices).encode()
output = ROOT / "dist" / (manifest["id"] + ".zip")
temporary = output.with_suffix(".pending")
with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as archive:
    for name, content in files.items():
        archive.writestr(manifest["id"] + "/" + name, content)
with ZipFile(temporary) as archive:
    assert archive.testzip() is None
    for name, content in files.items():
        assert archive.read(manifest["id"] + "/" + name) == content
temporary.replace(output)
print(f"{output.name}: {output.stat().st_size} bytes, {len(files)} files, {len(packages)} dependency licenses")
