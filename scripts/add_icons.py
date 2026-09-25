#!/usr/bin/env python3
"""Inline Lucide icons into chips, section titles, fact labels and buttons.

Idempotent: an element that already starts with <svg class="i"> is skipped.
Icons are resolved from the element's text, so each glyph says something about
its label (a decorative icon repeated down the page is worse than none).

Also adds the diagram animation toggle (#af-motion) to each case-study figure.

Icon geometry: Lucide (ISC license), read from a local lucide-react install:
    LUCIDE_DIR=path/to/lucide-react python3 scripts/add_icons.py   (or pass the path as the first argument)
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LUCIDE = pathlib.Path(sys.argv[1] if __name__ == "__main__" and len(sys.argv) > 1 else
                      os.environ.get("LUCIDE_DIR", "node_modules/lucide-react"))

# First match wins, so the most specific status comes first.
CHIP_RULES = [
    (("hackathon",), "zap"),
    (("on hold", "en pausa"), "pause"),
    (("rebuild", "reconstrucción", "in development", "en desarrollo"), "hammer"),
    (("runs locally", "corre en local", "se ejecuta en local", "not hosted", "sin hosting"), "laptop"),
    (("maintained", "se mantiene"), "archive"),
    (("private", "privad", "internal use", "uso interno"), "lock"),
    (("23 agents", "23 agentes"), "bot"),
    (("public repo", "repo público", "repositorio público"), "git-branch"),
    (("publicly deployed", "desplegado públicamente"), "globe"),
    (("gabe suite",), "puzzle"),
    (("september", "sep–", "septiembre", "sep-"), "calendar"),
]
H2_ICONS = {
    "selected work": "briefcase", "trabajo destacado": "briefcase",
    "experience": "history", "experiencia": "history",
    "other projects": "layout-grid", "otros proyectos": "layout-grid",
    "contact": "mail", "contacto": "mail",
    "problem": "circle-alert", "problema": "circle-alert",
    "how it works": "workflow", "cómo funciona": "workflow",
    "decisions": "signpost", "decisiones": "signpost",
    "limits": "triangle-alert", "límites": "triangle-alert",
    "stack": "layers", "stack and links": "layers", "stack y enlaces": "layers",
    "what went wrong, and what i would do now": "bug", "qué salió mal y qué haría ahora": "bug",
    "what it is for": "target", "para qué sirve": "target",
    "how it is built": "blocks", "cómo está construida": "blocks",
    "cómo está construido": "blocks",
}
DT_ICONS = {
    "role": "user", "rol": "user",
    "timeline": "calendar", "período": "calendar",
    "status": "activity", "estado": "activity",
    "code": "code", "código": "code", "código fuente": "code", "source": "code",
    "built so far": "package", "construido hasta ahora": "package",
    "model": "cpu", "modelo": "cpu",
    "backend": "server", "clients": "monitor-smartphone", "clientes": "monitor-smartphone",
    "quality": "shield-check", "calidad": "shield-check",
    "prompt lab": "flask-conical", "laboratorio de prompts": "flask-conical",
    "llm": "sparkles", "observability": "gauge", "observabilidad": "gauge",
    "other": "wrench", "otros": "wrench", "pipeline": "workflow",
    "site": "globe", "sitio": "globe", "site (spanish)": "external-link", "sitio web": "external-link",
    "stack": "layers", "links": "link", "enlaces": "link",
    "demo": "play",
}
BTN_ICONS = [
    (("cv (pdf",), "file-text"),
    (("email", "correo", "@"), "mail"),
    (("github",), "github"),
    (("linkedin",), "linkedin"),
    (("see the work", "ver el trabajo"), "arrow-down"),
]
MOTION_LABELS = {"en": ("Animation", "Play", "Pause"), "es": ("Animación", "Reproducir", "Pausar")}

_cache: dict[str, str] = {}


def icon(name: str, cls: str = "i") -> str:
    if name not in _cache:
        src = (LUCIDE / "dist/esm/icons" / f"{name}.js").read_text(encoding="utf-8")
        node = src[src.index("const __iconNode = ") + len("const __iconNode = "):]
        node = node[:node.index("];") + 1]
        node = re.sub(r"(\w+):", r'"\1":', node)  # JS object keys -> JSON
        parts = []
        for tag, attrs in json.loads(node):
            attrs.pop("key", None)
            parts.append(f"<{tag} " + " ".join(f'{k}="{v}"' for k, v in attrs.items()) + "/>")
        _cache[name] = "".join(parts)
    return (f'<svg class="{cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
            f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
            f"{_cache[name]}</svg>")


def plain(html: str) -> str:
    return re.sub(r"<[^>]+>", "", html).replace("&#64;", "@").strip().lower()


def pick(text: str, rules) -> str | None:
    for keys, name in rules:
        if any(k in text for k in keys):
            return name
    return None


def process(path: pathlib.Path, report: dict) -> None:
    s = path.read_text(encoding="utf-8")
    lang = "es" if "/es/" in f"/{path.relative_to(ROOT).as_posix()}" else "en"

    def chip(m):
        if m.group(2).startswith('<svg class="i'):
            return m.group(0)
        name = pick(plain(m.group(2)), CHIP_RULES)
        if not name:
            report["unmapped"].append(f"{path.name}: chip '{plain(m.group(2))}'")
            return m.group(0)
        report["chips"] += 1
        return f"{m.group(1)}{icon(name)}{m.group(2)}</span>"
    s = re.sub(r'(<span class="chip [a-z]+">)(.*?)</span>', chip, s)

    def h2(m):
        if m.group(2).startswith('<svg class="i'):
            return m.group(0)
        name = H2_ICONS.get(plain(m.group(2)))
        if not name:
            report["unmapped"].append(f"{path.name}: h2 '{plain(m.group(2))}'")
            return m.group(0)
        report["h2"] += 1
        return f'{m.group(1)}{icon(name, "i i-title")}{m.group(2)}</h2>'
    s = re.sub(r"(<h2[^>]*>)(.*?)</h2>", h2, s)

    def dt(m):
        if m.group(1).startswith('<svg class="i'):
            return m.group(0)
        name = DT_ICONS.get(plain(m.group(1)))
        if not name:
            report["unmapped"].append(f"{path.name}: dt '{plain(m.group(1))}'")
            return m.group(0)
        report["dt"] += 1
        return f"<dt>{icon(name)}{m.group(1)}</dt>"
    s = re.sub(r"<dt>(.*?)</dt>", dt, s)

    def btn(m):
        if m.group(2).startswith('<svg class="i'):
            return m.group(0)
        name = pick(plain(m.group(2)), BTN_ICONS)
        if not name:
            report["unmapped"].append(f"{path.name}: button '{plain(m.group(2))}'")
            return m.group(0)
        report["btn"] += 1
        return f"{m.group(1)}{icon(name)}{m.group(2)}</a>"
    s = re.sub(r'(<a class="btn[^"]*"[^>]*>)(.*?)</a>', btn, s)

    # Diagram animation: stage marker + one global toggle per page (H4 pause contract).
    if '<figure class="diagram"' in s and 'id="af-motion"' not in s:
        slug = "flow-" + path.stem
        label, play, pause = MOTION_LABELS[lang]
        bar = (f'<div class="fx-bar" id="af-motion" role="radiogroup" aria-label="{label}">'
               f'<button type="button" class="af-opt" data-id="on" role="radio" aria-checked="true">'
               f'{icon("play")}{play}</button>'
               f'<button type="button" class="af-opt" data-id="off" role="radio" aria-checked="false">'
               f'{icon("pause")}{pause}</button></div>\n          ')
        s = re.sub(r'<figure class="diagram"([^>]*)>\s*<svg',
                   lambda m: f'<figure class="diagram" data-fx="{slug}"{m.group(1)}>\n          {bar}<svg',
                   s, count=1)
        report["motion"] += 1

    path.write_text(s, encoding="utf-8")


def main() -> int:
    report = {"chips": 0, "h2": 0, "dt": 0, "btn": 0, "motion": 0, "unmapped": []}
    for p in sorted(ROOT.rglob("*.html")):
        if ".git" in p.parts or p.name.startswith("_"):
            continue
        process(p, report)
    print({k: v for k, v in report.items() if k != "unmapped"})
    for u in report["unmapped"]:
        print("UNMAPPED", u)
    return 1 if report["unmapped"] else 0


if __name__ == "__main__":
    sys.exit(main())
