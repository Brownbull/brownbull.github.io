#!/usr/bin/env python3
"""Put a technology logo in front of every stack tag (<ul class="tags"><li>…</li>).

The logo is the brand that appears FIRST in the tag's text, so "Supabase: Postgres, Auth"
gets Supabase and "PostgreSQL through Prisma 6" gets PostgreSQL. Brand marks come from
scripts/logos.json (Simple Icons, CC0 icon data); tools with no brand mark get a neutral
Lucide icon instead, so a row of tags never has gaps. Idempotent: a tag that already starts
with an icon is skipped.

    python3 scripts/build_projects.py && python3 scripts/add_icons.py && python3 scripts/add_logos.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from add_icons import icon  # noqa: E402  (Lucide, for tools without a brand mark)

LOGOS = json.loads((ROOT / "scripts" / "logos.json").read_text(encoding="utf-8"))["icons"]

# keyword (lower case) -> simple-icons slug, or "lucide:<name>" for tools with no brand mark
KEYWORDS = {
    "react flow": "xyflow", "@xyflow": "xyflow", "pydanticai": "pydantic", "pydantic": "pydantic",
    "fastapi": "fastapi", "sqlalchemy": "sqlalchemy", "postgresql": "postgresql", "postgres": "postgresql",
    "pl/pgsql": "postgresql", "supabase": "supabase", "prisma": "prisma", "gemini": "googlegemini",
    "claude": "claude", "langchain": "langchain", "docker": "docker", "next.js": "nextdotjs",
    "react": "react", "expo": "expo", "typescript": "typescript", "firebase": "firebase",
    "python": "python", "bash": "gnubash", "markdown": "markdown", "eleventy": "eleventy",
    "three.js": "threedotjs", "vite": "vite", "vitest": "vitest", "zod": "zod", "github actions": "githubactions",
    "railway": "railway", "resend": "resend", "leaflet": "leaflet", "vercel": "vercel", "node": "nodedotjs",
    "mermaid": "mermaid", "pytest": "pytest", "tanstack": "reactquery", "yaml": "yaml", "json": "json",
    "html": "html5", "mcp": "modelcontextprotocol", "git": "git",
    "playwright": "lucide:drama", "langfuse": "lucide:activity", "pypdf": "lucide:file-text",
    "alembic": "lucide:flask-conical", "zustand": "lucide:box", "junit": "lucide:list-checks",
    "graft": "lucide:git-fork",
    "pandas": "pandas", "numpy": "numpy", "mysql": "mysql", "linux": "linux", "ruff": "ruff",
    "anthropic": "anthropic", "shell": "gnubash", "json-rpc": "json", "aws": "lucide:cloud", "mainframe": "lucide:server",
    "octokit": "lucide:git-branch", "celery": "celery", "graphviz": "lucide:workflow", "c": "c", "plotly": "plotly", "igraph": "lucide:share-2", "aix": "lucide:server", "jcl": "lucide:file-code",
    "pymupdf": "lucide:file-text", "mypy": "lucide:shield-check", "pip-audit": "lucide:shield-check", "db2": "lucide:database",
}


def luminance(hexcode: str) -> float:
    def ch(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hexcode[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def pick(text: str) -> str | None:
    low = text.lower()
    hits = []
    for key, slug in KEYWORDS.items():
        m = re.search(r"(?<![a-z])" + re.escape(key) + r"(?![a-z])", low)
        if m:
            hits.append((m.start(), -len(key), slug))
    return min(hits)[2] if hits else None


def logo(slug: str) -> str:
    if slug.startswith("lucide:"):
        return icon(slug.split(":", 1)[1], "i logo-i")
    d = LOGOS[slug]
    lum = luminance(d["hex"])
    tone = " lo-dk" if lum < 0.08 else (" lo-lt" if lum > 0.4 else "")
    return (f'<svg class="logo{tone}" viewBox="0 0 24 24" width="14" height="14" fill="#{d["hex"]}" aria-hidden="true" '
            f'focusable="false" style="--brand:#{d["hex"]}"><path d="{d["path"]}"/></svg>')


def main() -> int:
    added, missing = 0, set()
    for path in sorted(ROOT.rglob("*.html")):
        if ".git" in path.parts or path.name.startswith("_"):
            continue
        s = path.read_text(encoding="utf-8")

        def tags(m: re.Match) -> str:
            def li(n: re.Match) -> str:
                nonlocal added
                inner = n.group(1)
                # re-render logos this script placed before (keeps markup current); leave other icons alone
                inner = re.sub(r'^<svg class="(?:logo[^"]*|i logo-i)"(?:(?!</svg>).)*</svg>', "", inner, flags=re.S)
                if inner.startswith("<svg"):
                    return n.group(0)
                slug = pick(re.sub(r"<[^>]+>", "", inner))
                if not slug:
                    missing.add(re.sub(r"<[^>]+>", "", inner))
                    return n.group(0)
                added += 1
                return f"<li>{logo(slug)}{inner}</li>"
            return re.sub(r"<li>(.*?)</li>", li, m.group(0))

        new = re.sub(r'<ul class="tags[^"]*"[^>]*>.*?</ul>', tags, s, flags=re.S)
        if new != s:
            path.write_text(new, encoding="utf-8")
    print({"logos_added": added})
    for t in sorted(missing):
        print("NO LOGO", t)
    return 0


if __name__ == "__main__":
    sys.exit(main())
