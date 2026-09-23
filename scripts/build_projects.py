#!/usr/bin/env python3
"""Build the short project pages (EN + ES) and the card carousels from scripts/projects/*.json.

Each spec holds verified copy, an architecture diagram on a 5x3 grid and the screens for the
carousel. The diagram uses the same grammar as the hand-drawn case-study diagrams (160x66 nodes,
188px column pitch, group labels, AI nodes highlighted, a bottom band), so site.js animates it.

    python3 scripts/build_projects.py          # write pages + card carousels
    python3 scripts/add_icons.py               # then add icons and the animation toggle
"""
from __future__ import annotations

import html
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPECS = ROOT / "scripts" / "projects"
sys.path.insert(0, str(ROOT / "scripts"))
from add_icons import icon  # noqa: E402

SITE = "https://brownbull.github.io"
COL, ROW, W, H = 188, 150, 160, 66
TOP = 36

T = {
    "en": dict(skip="Skip to content", nav="Main", work="Work", exp="Experience", contact="Contact",
               cv="CV (PDF)", lang="Language", back="← Other projects", kind="project",
               screens="Screens", built="How it is built", works="How it works", stack_links="Stack and links",
               stack="Stack", status="Status", links="Links", prev="Previous screen", next="Next screen",
               goto="Go to screen", of="of", car="screens", foot="Backend Engineer, Python &amp; AI",
               email="Email", details="Architecture and screens →", next_proj="→"),
    "es": dict(skip="Saltar al contenido", nav="Principal", work="Trabajo", exp="Experiencia", contact="Contacto",
               cv="CV (PDF, en inglés)", lang="Idioma", back="← Otros proyectos", kind="proyecto",
               screens="Pantallas", built="Cómo está construido", works="Cómo funciona", stack_links="Stack y enlaces",
               stack="Stack", status="Estado", links="Enlaces", prev="Pantalla anterior", next="Pantalla siguiente",
               goto="Ir a la pantalla", of="de", car="pantallas", foot="Ingeniero Backend, Python e IA",
               email="Correo", details="Arquitectura y pantallas →", next_proj="→"),
}

e = html.escape


# ---------------------------------------------------------------- diagram
def diagram(arch: dict, lang: str, slug: str) -> str:
    nodes = {n["id"]: n for n in arch["nodes"]}
    rows = max(n["row"] for n in arch["nodes"]) + 1
    ny = lambda r: TOP + r * ROW  # noqa: E731
    nx = lambda c: 20 + c * COL  # noqa: E731
    band = arch.get(f"band_{lang}")
    height = ny(rows - 1) + H + (30 + 44 if band else 0) + 30
    out = [f'<svg viewBox="0 0 952 {height}" role="img" aria-labelledby="{slug}-dt {slug}-dd">',
           f'<title id="{slug}-dt">{e(arch.get("title_" + lang, T[lang]["built"]))}</title>',
           f'<desc id="{slug}-dd">{e(arch["desc_" + lang])}</desc>',
           '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
           'orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>']
    for g in arch.get("groups", []):
        out.append(f'<text class="group-label" x="20" y="{ny(g["row"]) - 10}">{e(g["label_" + lang])}</text>')
    for n in arch["nodes"]:
        x, y = nx(n["col"]), ny(n["row"])
        parts = [f'<rect x="{x}" y="{y}" width="{W}" height="{H}" rx="8"/>',
                 f'<text x="{x + 12}" y="{y + 24}">{e(n["title_" + lang])}</text>']
        for i, line in enumerate(n.get("sub_" + lang, [])[:2]):
            parts.append(f'<text class="sub" x="{x + 12}" y="{y + 44 + 15 * i}">{e(line)}</text>')
        out.append(f'<g class="node{" ai" if n.get("ai") else ""}">{"".join(parts)}</g>')
    lane: dict[int, int] = {}
    for ed in arch["edges"]:
        a, b = nodes[ed["from"]], nodes[ed["to"]]
        ax, ay, bx, by = nx(a["col"]), ny(a["row"]), nx(b["col"]), ny(b["row"])
        cls = "edge dashed" if ed.get("dashed") else "edge"
        label = ed.get("label_" + lang)
        lx = ly = None
        anchor = "middle"
        if a["row"] == b["row"] and b["col"] == a["col"] + 1:
            d = f"M{ax + W} {ay + H // 2} H{bx - 2}"
        elif a["row"] == b["row"] and not any(
                n["row"] == a["row"] and a["col"] < n["col"] < b["col"] for n in arch["nodes"]):
            # Longer same-row hop over empty cells: a straight line, labelled above its midpoint.
            d = f"M{ax + W} {ay + H // 2} H{bx - 2}"
            lx, ly = (ax + W + bx) // 2, ay + H // 2 - 8
        elif a["row"] == b["row"]:
            # Longer same-row hop: dip under the row so it does not cross the nodes in between.
            k = lane.get(a["row"], 0); lane[a["row"]] = k + 1
            dip = ay + H + 18 + 10 * k
            d = f"M{ax + W // 2} {ay + H} V{dip} H{bx + W // 2} V{by + H + 2}"
            lx, ly = (ax + bx + W) // 2, dip + 16
        elif a["col"] == b["col"]:
            down = b["row"] > a["row"]
            y0, y1 = (ay + H, by - 2) if down else (ay, by + H + 2)
            d = f"M{ax + W // 2} {y0} V{y1}"
            # Label on the right unless the node is in the last column or another edge leaves it rightwards.
            left = a["col"] == 4 or any(o is not ed and o["from"] == ed["from"] and nodes[o["to"]]["col"] > a["col"]
                                        for o in arch["edges"])
            lx, ly = ax + W // 2 + (-8 if left else 8), (y0 + y1) // 2 + 4
            anchor = "end" if left else "start"
        else:
            down = b["row"] > a["row"]
            gap_top = (ay + H) if down else (by + H)
            k = lane.get(min(a["row"], b["row"]), 0); lane[min(a["row"], b["row"])] = k + 1
            mid = gap_top + (ROW - H) // 2 - 8 + 10 * k
            y0, y1 = (ay + H, by - 2) if down else (ay, by + H + 2)
            d = f"M{ax + W // 2} {y0} V{mid} H{bx + W // 2} V{y1}"
            lx, ly = (ax + bx + W) // 2, mid - 6
        out.append(f'<path class="{cls}" d="{d}"/>')
        if label and lx is not None:
            out.append(f'<text class="edge-label" x="{lx}" y="{ly}" text-anchor="{anchor}">{e(label)}</text>')
    if band:
        by = ny(rows - 1) + H + 30
        out.append(f'<g class="band"><rect x="20" y="{by}" width="912" height="44" rx="8"/>'
                   f'<text x="36" y="{by + 27}">{e(band)}</text></g>')
    out.append("</svg>")
    return "\n          ".join(out)


# ---------------------------------------------------------------- carousel
def carousel(shots: list[dict], lang: str, name: str, prefix: str, compact: bool) -> str:
    t = T[lang]
    n = len(shots)
    slides = []
    for i, s in enumerate(shots):
        lazy = "" if (i == 0 and not compact) else ' loading="lazy"'
        fit = ' class="fit-left"' if s.get("fit") == "left" else ""
        slides.append(
            f'<figure class="car-slide" role="group" aria-roledescription="slide" aria-label="{i + 1} {t["of"]} {n}">'
            f'<div class="car-img"><img{fit} src="{prefix}assets/img/{s["file"]}" width="{s["w"]}" height="{s["h"]}" '
            f'alt="{e(s["alt_" + lang])}"{lazy}></div>'
            f'<figcaption>{e(s["caption_" + lang])}</figcaption></figure>')
    dots = "".join(f'<button type="button" class="car-dot" aria-label="{t["goto"]} {i + 1}"'
                   f' aria-current="{"true" if i == 0 else "false"}"></button>' for i in range(n))
    nav = (f'<div class="car-nav"><button type="button" class="car-btn car-prev" aria-label="{t["prev"]}">'
           f'{icon("chevron-left")}</button><div class="car-dots">{dots}</div>'
           + ("" if compact else f'<span class="car-count" aria-hidden="true">1 / {n}</span>')
           + f'<button type="button" class="car-btn car-next" aria-label="{t["next"]}">{icon("chevron-right")}</button></div>')
    return (f'<div class="carousel{" compact" if compact else ""}" role="region" aria-roledescription="carousel" '
            f'aria-label="{e(name)}: {t["car"]}"><div class="car-track" tabindex="0">{"".join(slides)}</div>{nav}</div>')


# ---------------------------------------------------------------- page
def lead(text: str) -> str:
    """Bold the first sentence so a long, verified bullet can be scanned."""
    m = re.match(r"(.+?[.:])\s+(.*)", text, flags=re.S)
    if not m or len(m.group(1)) > 140:
        return e(text)
    return f"<strong>{e(m.group(1))}</strong> {e(m.group(2))}"


def pend(obj: dict) -> str:
    """Owner-pending marker; scripts/check_site.py blocks publishing while any remain."""
    return f' data-pending="{obj["pending"]}"' if obj.get("pending") else ""


def page(spec: dict, lang: str, next_spec: dict | None) -> str:
    t = T[lang]
    slug, name = spec["slug"], spec.get("name_" + lang, spec["name"])
    en_url, es_url = f"{SITE}/projects/{slug}.html", f"{SITE}/es/projects/{slug}.html"
    url = en_url if lang == "en" else es_url
    up = "../" if lang == "en" else "../../"          # to the site root (assets, cv.pdf)
    home = "../index.html"                            # the index in the same language
    title = f"{name} — {t['kind']} · Gabriel Cárcamo"
    desc = spec["lede_" + lang].split(". ")[0].rstrip(".") + "."
    other = (f'<a href="../es/projects/{slug}.html" hreflang="es" lang="es">ES</a>' if lang == "en"
             else f'<a href="../../projects/{slug}.html" hreflang="en" lang="en">EN</a>')
    langs = (f'<span aria-current="true">EN</span>{other}' if lang == "en"
             else f'{other}<span aria-current="true">ES</span>')
    chips = "".join(f'<span class="chip {c["kind"]}">{e(c[lang])}</span>' for c in spec["chips"])
    bullets = "".join(f"<li>{lead(b)}</li>" for b in spec["how_it_works_" + lang])
    links = " · ".join(f'<a href="{e(l["url"])}"{pend(l)}>{e(l["label_" + lang])}</a>' for l in spec.get("links", [])) \
        or f'<span class="muted">{e(spec.get("no_links_" + lang, ""))}</span>'
    facts = (f'<div><dt>{t["status"]}</dt><dd>{e(spec["status_" + lang])}</dd></div>'
             f'<div><dt>{t["stack"]}</dt><dd>{e(" · ".join(spec["stack"]))}</dd></div>'
             f'<div><dt>{t["links"]}</dt><dd>{links}</dd></div>')
    caption = spec["architecture"].get("caption_" + lang)
    nxt = ""
    if next_spec:
        nxt = f'<a href="{next_spec["slug"]}.html">{e(next_spec.get("name_" + lang, next_spec["name"]))} {t["next_proj"]}</a>'
    og_locale = '\n  <meta property="og:locale" content="es_CL">' if lang == "es" else ""
    return f"""<!doctype html>
<html lang="{lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)}</title>
  <meta name="description" content="{e(desc)}">
  <meta property="og:title" content="{e(title)}">
  <meta property="og:description" content="{e(desc)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="{url}">{og_locale}
  <meta property="og:image" content="{SITE}/assets/img/og-card.png">
  <meta property="og:image:alt" content="Gabriel Cárcamo — Senior Backend Engineer, Python and AI">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="{url}">
  <link rel="alternate" hreflang="en" href="{en_url}">
  <link rel="alternate" hreflang="es" href="{es_url}">
  <link rel="icon" href="{up}assets/img/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="{up}assets/css/site.css">
</head>
<body>
  <a class="skip" href="#main">{t["skip"]}</a>

  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="{home}">Gabriel Cárcamo</a>
      <nav class="nav" aria-label="{t["nav"]}">
        <a href="{home}#work">{t["work"]}</a>
        <a href="{home}#experience">{t["exp"]}</a>
        <a href="{home}#contact">{t["contact"]}</a>
        <a href="{up}cv.pdf">{t["cv"]}</a>
        <span class="lang" role="group" aria-label="{t["lang"]}">{langs}</span>
      </nav>
    </div>
  </header>

  <main id="main" class="case project">
    <div class="wrap">
      <a class="back" href="{home}#more">{t["back"]}</a>

      <div class="case-head">
        <div class="chips">{chips}</div>
        <h1>{e(name)}</h1>
        <p class="lede">{e(spec["lede_" + lang])}</p>
      </div>

      <section class="project-screens" aria-label="{t["screens"]}">
        {carousel(spec["shots"], lang, name, up, compact=False)}
      </section>
    </div>

    <section>
      <div class="wrap">
        <h2>{t["built"]}</h2>
        <figure class="diagram" tabindex="0"{pend(spec["architecture"])}>
          {diagram(spec["architecture"], lang, "d-" + slug)}
          {f"<figcaption>{e(caption)}</figcaption>" if caption else ""}
        </figure>
      </div>
    </section>

    <section>
      <div class="wrap prose">
        <h2>{t["works"]}</h2>
        <ul class="points">{bullets}</ul>
      </div>
    </section>

    <section>
      <div class="wrap prose">
        <h2>{t["stack_links"]}</h2>
        <dl class="facts" style="margin-top:0">{facts}</dl>
      </div>
    </section>

    <section>
      <div class="wrap next-case">
        <a href="{home}#more">{t["back"]}</a>
        {nxt}
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <p class="muted" style="margin:0">Gabriel Cárcamo · {t["foot"]}</p>
      <ul>
        <li><a href="mailto:carcamo.gabriel&#64;gmail.com">{t["email"]}</a></li>
        <li><a href="https://www.linkedin.com/in/gabriel-carcamo">LinkedIn</a></li>
        <li><a href="https://github.com/Brownbull">GitHub</a></li>
      </ul>
    </div>
  </footer>
  <script src="{up}assets/js/site.js" defer></script>
</body>
</html>
"""


# ---------------------------------------------------------------- index cards
def card_carousel(index_path: pathlib.Path, lang: str, card: dict, shots: list[dict], name: str,
                  page_href: str | None) -> None:
    """Swap one card's media block for a compact carousel (idempotent, between markers)."""
    s = index_path.read_text(encoding="utf-8")
    key = card.get("h3_" + lang, card.get("h3"))
    h = re.search(r"<h3>(?:<a[^>]*>)?" + re.escape(key) + r"(?:</a>)?</h3>", s)
    if not h:
        raise SystemExit(f"{index_path.name}: card '{key}' not found")
    start = s.rindex("<article", 0, h.start())
    end = s.index("</article>", h.end())
    art = s[start:end]
    prefix = "" if lang == "en" else "../"
    block = f"<!-- car:{card['id']} -->{carousel(shots, lang, name, prefix, compact=True)}<!-- /car:{card['id']} -->"
    if f"<!-- car:{card['id']} -->" in art:
        art = re.sub(r"<!-- car:%s -->.*?<!-- /car:%s -->" % (card["id"], card["id"]), lambda m: block, art, flags=re.S)
    else:
        m = re.search(r'<a class="media"[^>]*>.*?</a>|<div class="media">.*?</div>', art, flags=re.S)
        if not m:
            raise SystemExit(f"{index_path.name}: no media block in card '{key}'")
        art = art[:m.start()] + block + art[m.end():]
    if page_href:
        art = re.sub(r"<h3>" + re.escape(key) + r"</h3>", f'<h3><a href="{page_href}">{key}</a></h3>', art)
        if page_href not in art.split('<div class="links">')[-1]:
            art = art.replace('<div class="links">',
                              f'<div class="links"><a href="{page_href}">{T[lang]["details"]}</a> · ', 1)
    index_path.write_text(s[:start] + art + s[end:], encoding="utf-8")


def main() -> int:
    specs = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(SPECS.glob("*.json"))]
    specs.sort(key=lambda sp: sp.get("order", 99))
    pages = [sp for sp in specs if sp.get("page", True)]
    for i, sp in enumerate(pages):
        nxt = pages[(i + 1) % len(pages)] if len(pages) > 1 else None
        for lang, base in (("en", ROOT / "projects"), ("es", ROOT / "es" / "projects")):
            (base / f"{sp['slug']}.html").write_text(page(sp, lang, nxt), encoding="utf-8")
    for sp in specs:
        for lang, idx in (("en", ROOT / "index.html"), ("es", ROOT / "es" / "index.html")):
            href = f"projects/{sp['slug']}.html" if sp.get("page", True) else None
            card_carousel(idx, lang, sp["card"], sp["shots"], sp.get("name_" + lang, sp["name"]), href)
    print(f"{len(pages)} project pages x 2 languages, {len(specs)} card carousels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
