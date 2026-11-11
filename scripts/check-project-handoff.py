#!/usr/bin/env python3
"""Offline integrity/navigation check for the portable handoff; never runs SDK code."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]

def digest(path):
    assert path.is_file() and not path.is_symlink(), str(path)
    return hashlib.sha256(path.read_bytes()).hexdigest()

def check_manifest(path, base):
    data = json.loads(path.read_text())
    for name, expected in data.items():
        resolved = (base / name).resolve()
        assert resolved.is_relative_to(base.resolve()), name
        assert digest(resolved) == expected, name
    return len(data)

def main():
    candidate = check_manifest(ROOT/'work-in-progress/sdk-0.47-manifest.json', ROOT/'work-in-progress/sdk-0.47')
    evidence = check_manifest(ROOT/'docs/project-evidence/manifest.json', ROOT/'docs/project-evidence')
    vendor = json.loads((ROOT/'.agents/vendor-manifest.json').read_text())
    for name, expected in vendor['files'].items():
        assert digest(ROOT/'.agents'/name) == expected, name
    archive = json.loads((ROOT/'docs/project-evidence/zalo-sdk-0.47-archive.json').read_text())
    assert digest(ROOT/'work-in-progress/zalo-personal-sdk-0.47.0.tgz') == archive['sha256']
    baseline = json.loads((ROOT/'docs/project-evidence/zalo-sdk-0.46-postreview-all-manifest.json').read_text())
    unchanged = {n:h for n,h in baseline.items() if n not in {'README.md','docs/operation-status.md'}}
    for name, expected in unchanged.items():
        assert digest(ROOT/name) == expected, name
    assert json.loads((ROOT/'package.json').read_text())['version'] == '0.46.0'
    assert json.loads((ROOT/'work-in-progress/sdk-0.47/package.json').read_text())['version'] == '0.47.0'
    files = list((ROOT/'.agents').rglob('*.md')) + [ROOT/n for n in ['AGENTS.md','README.md','docs/operation-status.md','docs/project-handoff.md','docs/project-roadmap.md','docs/developer-guide.md','docs/project-evidence/README.md']]
    links = 0
    for path in files:
        for link in re.findall(r'\]\(([^)]+)\)', path.read_text()):
            url = link.split('#')[0]
            if not url or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', url) or '<' in url:
                continue
            assert (path.parent/url).exists(), (str(path.relative_to(ROOT)), url)
            links += 1
    # Historical results must have actual terminal success records, not just prose counts.
    for phase in ['inherited-focused319','source-new22','installed-public95','installed-strict41','installed-imports','baseline046-positive-controls','first-build','final-pack']:
        record = json.loads((ROOT/f'docs/project-evidence/zalo-sdk-0.47-{phase}.process.json').read_text())
        assert record['exitCode'] == 0 and record['terminalObserved'] and not record['boundExceeded'], phase
    negative = json.loads((ROOT/'docs/project-evidence/zalo-sdk-0.47-baseline046-missing-operation.process.json').read_text())
    assert negative['exitCode'] == 1 and negative['terminalObserved']
    return {'candidateFiles':candidate,'evidenceFiles':evidence,'unchangedBaselineFiles':len(unchanged),'vendoredFiles':len(vendor['files']),'vendoredSkills':len(vendor['selectedSkills']),'localLinksChecked':links,'archiveHashExact':True,'rootVersion':'0.46.0','candidateVersion':'0.47.0','historicalChecksTerminal':True,'sdkTestsRerun':False,'liveOrNativeExecuted':False}

if __name__ == '__main__':
    print(json.dumps(main(), indent=2))
