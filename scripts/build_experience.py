#!/usr/bin/env python3
"""Render the hero summary and the tabbed Experience section of both index pages from scripts/experience.json.

The copy in experience.json was checked against the career sources and the correction ledger;
edit it there, never in the HTML. Tabs follow the WAI-ARIA tabs pattern and degrade to all
panels stacked when JavaScript is off (site.js adds .is-tabs and hides the inactive panels).

    python3 scripts/build_experience.py   (then add_icons, add_logos, stamp_chrome as usual)
"""
from __future__ import annotations

import html
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from add_icons import icon  # noqa: E402
from build_projects import carousel  # noqa: E402

SPEC = json.loads((ROOT / "scripts" / "experience.json").read_text(encoding="utf-8"))
UI = {"en": dict(h2="Experience", tabs="Experience", stack="Stack", where="Where"),
      "es": dict(h2="Experiencia", tabs="Experiencia", stack="Stack tecnológico", where="Dónde")}


e = html.escape


def tags(items: list[str], label: str, cls: str = "tags") -> str:
    return f'<ul class="{cls}" aria-label="{label}">' + "".join(f"<li>{e(t)}</li>" for t in items) + "</ul>"


def section(lang: str) -> str:
    u, out = UI[lang], []
    buttons, panels = [], []
    for i, t in enumerate(SPEC["tabs"]):
        sel = i == 0
        key, label = t["key"], e(t["label_" + lang])
        buttons.append(
            f'<button type="button" class="xtab" role="tab" id="xt-{key}" aria-controls="xp-{key}" '
            f'aria-selected="{"true" if sel else "false"}" tabindex="{0 if sel else -1}" aria-label="{label}">'
            f'{icon(t["icon"])}<span class="xt-full">{label}</span><span class="xt-short" aria-hidden="true">{e(t["short_" + lang])}</span></button>')
        if key == "history":
            rows = []
            for r in SPEC["roles"]:
                bl = "".join(f"<li>{e(b)}</li>" for b in r["bullets_" + lang])
                rows.append(f'<li>\n              <p class="when">{r.get("when_" + lang, r["when"])}</p>\n              <div>\n                <h3>{r["title_" + lang]}</h3>\n'
                            f'                <p class="org">{r["org_" + lang]}</p>\n' + (f"                <ul>{bl}</ul>\n" if bl else "") +
                            "              </div>\n            </li>")
            body = ('<ol class="timeline">\n            ' + "\n            ".join(rows) + '\n          </ol>\n'
                    f'          <p class="muted" style="margin-top:28px">{e(SPEC["languages_" + lang])}</p>')
        else:
            items = []
            for it in t["items"]:
                prefix = "" if lang == "en" else "../"
                if it.get("images"):
                    fig = carousel(it["images"], lang, it["title_" + lang], prefix, compact=False)
                    items.append(f'<article class="xitem{" wide" if it.get("wide") else ""}"><h4>{e(it["title_" + lang])}</h4><p>{e(it["text_" + lang])}</p>{fig}'
                                 f'<p class="where">{icon("map-pin")}<span class="sr-only">{u["where"]}: </span>{e(it["where_" + lang])}</p>'
                                 + tags(it["tech"], u["stack"]) + "</article>")
                    continue
                img = it.get("image")
                fig = (f'<figure class="ximg"><img src="{"" if lang == "en" else "../"}assets/img/{img["file"]}" width="{img["w"]}" height="{img["h"]}" '
                       f'alt="{e(img["alt_" + lang])}" loading="lazy"><figcaption>{e(img["caption_" + lang])}</figcaption></figure>') if img else ""
                items.append(f'<article class="xitem{" wide" if it.get("wide") else ""}"><h4>{e(it["title_" + lang])}</h4><p>{e(it["text_" + lang])}</p>{fig}'
                             f'<p class="where">{icon("map-pin")}<span class="sr-only">{u["where"]}: </span>{e(it["where_" + lang])}</p>'
                             + tags(it["tech"], u["stack"]) + "</article>")
            body = (f'<p class="muted xblurb">{e(t["blurb_" + lang])}</p>\n          <div class="xitems">' + "".join(items) + "</div>")
        panels.append(f'<div class="xpanel" role="tabpanel" id="xp-{key}" aria-labelledby="xt-{key}" tabindex="0">\n'
                      f'          <h3 class="xpanel-title">{label}</h3>\n          {body}\n        </div>')
    out.append('<section id="experience">\n      <div class="wrap">\n        <div class="section-head">\n'
               f'          <h2>{u["h2"]}</h2>\n          <p class="muted">{e(SPEC["intro_" + lang])}</p>\n        </div>\n'
               f'        <div class="xtabs">\n          <div class="xtab-list" role="tablist" aria-label="{u["tabs"]}">'
               + "".join(buttons) + "</div>\n        " + "\n        ".join(panels) + "\n        </div>\n      </div>\n    </section>")
    return "".join(out)


def main() -> int:
    for lang, path in (("en", ROOT / "index.html"), ("es", ROOT / "es" / "index.html")):
        s = path.read_text(encoding="utf-8")
        # Experience section (no nested sections inside it)
        a = s.index('<section id="experience">'); b = s.index("</section>", a) + len("</section>")
        s = s[:a] + section(lang) + s[b:]
        # Hero: summary + stack tags (replace the previous stack list too, so re-runs are idempotent)
        h = s.index('<section class="hero">'); l0 = s.index('<p class="lede">', h); l1 = s.index("</p>", l0) + 4
        if s.startswith('\n        <ul class="tags hero-stack"', l1):
            l1 = s.index("</ul>", l1) + 5
        hero = SPEC["hero"]
        s = (s[:l0] + f'<p class="lede">{e(hero["lede_" + lang])}</p>\n        '
             + tags(hero["stack_" + lang], UI[lang]["stack"], "tags hero-stack") + s[l1:])
        m0 = s.index('<p class="meta-line">', h); m1 = s.index("</p>", m0) + 4
        meta = e(hero["meta_" + lang]).replace("Gabe Suite", '<a href="projects/gabe-suite.html">Gabe Suite</a>', 1)
        s = s[:m0] + f'<p class="meta-line">{meta}</p>' + s[m1:]
        path.write_text(s, encoding="utf-8")
    print("experience + hero rendered (EN, ES)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
