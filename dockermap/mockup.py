from __future__ import annotations

import json
from html import escape
from typing import Any, Dict, List, Optional

from dockermap.store import build_page_summary, normalize_snapshot

def build_summary(snapshot: Dict[str, Any], **filters: Any) -> Dict[str, Any]:
    store = normalize_snapshot(snapshot)
    return build_page_summary(store, **filters)


def render_page_html(
    summary: Dict[str, Any],
    page: str,
    *,
    container_name: Optional[str] = None,
    service_filter: Optional[str] = None,
) -> str:
    active = _normalize_active(page)
    title = _page_title(active, container_name)
    content = _render_page_content(summary, active, container_name, service_filter)
    data = json.dumps(summary)
    active_container = container_name or ""
    active_service = service_filter or ""

    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escape(title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet" />
    <style>
      :root {{
        --surface: #0e0e0e;
        --surface-low: #131313;
        --surface-mid: #1a1a1a;
        --surface-high: #20201f;
        --surface-top: #262626;
        --primary: #8dedec;
        --primary-container: #4dafaf;
        --success: #78ef9a;
        --warning: #f5a623;
        --error: #ff716c;
        --ink: #ffffff;
        --muted: #adaaaa;
        --outline: rgba(118, 117, 117, 0.18);
      }}
      * {{ box-sizing: border-box; }}
      html, body {{ margin: 0; min-height: 100%; background: var(--surface); color: var(--ink); }}
      body {{
        font-family: 'Inter', sans-serif;
        background:
          radial-gradient(circle at top right, rgba(141, 237, 236, 0.06), transparent 18%),
          radial-gradient(circle at bottom left, rgba(77, 175, 175, 0.08), transparent 20%),
          var(--surface);
      }}
      a {{ color: inherit; }}
      .headline {{ font-family: 'Space Grotesk', sans-serif; }}
      .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }}
      .app {{
        min-height: 100vh;
        background-image: radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
        background-size: 42px 42px;
      }}
      .topbar {{
        position: fixed;
        inset: 0 0 auto 0;
        height: 72px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 24px;
        background: rgba(14, 14, 14, 0.92);
        backdrop-filter: blur(18px);
        z-index: 20;
      }}
      .brand {{
        color: var(--primary);
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700;
        letter-spacing: -0.04em;
        text-transform: uppercase;
        text-decoration: none;
        font-size: 1.4rem;
      }}
      .topbar-left, .topbar-right {{
        display: flex;
        align-items: center;
      }}
      .topnav {{
        display: flex;
        gap: 24px;
        margin-left: 28px;
      }}
      .topnav a {{
        color: #7d7d7d;
        text-decoration: none;
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700;
        font-size: 0.94rem;
        padding-bottom: 8px;
      }}
      .topnav a.active {{
        color: var(--primary);
        border-bottom: 2px solid var(--primary);
      }}
      .search {{
        width: min(420px, 32vw);
        display: flex;
        align-items: center;
        gap: 10px;
        background: var(--surface-high);
        color: var(--muted);
        padding: 12px 14px;
        border-radius: 8px;
      }}
      .search input {{
        width: 100%;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--ink);
        font: inherit;
      }}
      .ghost-btn, .icon-btn, .cta-link {{
        border: 0;
        text-decoration: none;
        cursor: pointer;
        font: inherit;
      }}
      .ghost-btn {{
        background: var(--surface-mid);
        color: var(--ink);
        padding: 12px 14px;
        border-radius: 8px;
      }}
      .icon-btn {{
        width: 42px;
        height: 42px;
        border-radius: 8px;
        background: var(--surface-mid);
        color: var(--primary);
        display: flex;
        align-items: center;
        justify-content: center;
      }}
      .shell {{
        display: flex;
        min-height: 100vh;
        padding-top: 72px;
      }}
      .sidebar {{
        width: 250px;
        background: var(--surface-low);
        padding: 26px 18px;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }}
      .engine-card {{
        padding: 12px 10px 18px;
      }}
      .dot {{
        width: 8px;
        height: 8px;
        border-radius: 999px;
        display: inline-block;
        box-shadow: 0 0 12px currentColor;
      }}
      .running {{ color: var(--success); }}
      .warning {{ color: var(--warning); }}
      .error {{ color: var(--error); }}
      .engine-meta {{
        margin-top: 10px;
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        color: var(--muted);
      }}
      .engine-state {{
        margin-top: 4px;
        font-size: 0.7rem;
        color: var(--success);
        font-weight: 700;
        text-transform: uppercase;
      }}
      .nav-stack {{
        display: grid;
        gap: 6px;
      }}
      .nav-item {{
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 14px;
        color: #7f7f7f;
        text-decoration: none;
        font-size: 0.92rem;
        border-right: 3px solid transparent;
      }}
      .nav-item.active {{
        color: var(--primary);
        background: var(--surface-mid);
        border-right-color: var(--primary);
      }}
      .primary-btn {{
        margin-top: auto;
        background: linear-gradient(135deg, var(--primary), var(--primary-container));
        color: #002828;
        padding: 14px 16px;
        border-radius: 8px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-size: 0.75rem;
        font-weight: 700;
        text-decoration: none;
        text-align: center;
      }}
      .sidebar-footer {{
        display: grid;
        gap: 6px;
        margin-top: 10px;
      }}
      .sidebar-footer a {{
        color: #737373;
        text-decoration: none;
        padding: 10px 12px;
        font-size: 0.85rem;
      }}
      .workspace {{
        position: relative;
        flex: 1;
        overflow: auto;
      }}
      .workspace-inner {{
        min-height: calc(100vh - 72px);
        padding: 28px 28px 36px;
        position: relative;
      }}
      .page-header {{
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 18px;
        margin-bottom: 24px;
      }}
      .page-header h1 {{
        margin: 0 0 8px;
        font-size: clamp(2.2rem, 5vw, 4rem);
        line-height: 0.95;
        letter-spacing: -0.06em;
      }}
      .page-header p {{
        margin: 0;
        color: var(--muted);
        max-width: 44ch;
      }}
      .panel {{
        background: rgba(26, 26, 26, 0.82);
        backdrop-filter: blur(18px);
        border-radius: 14px;
        padding: 18px;
      }}
      .panel-title {{
        margin: 0 0 14px;
        font-family: 'Space Grotesk', sans-serif;
        font-size: 1.02rem;
        letter-spacing: -0.03em;
      }}
      .hero-grid {{
        position: relative;
        min-height: 760px;
      }}
      .hero-copy {{
        position: absolute;
        top: 0;
        left: 0;
        z-index: 3;
        max-width: 420px;
      }}
      .eyebrow {{
        color: var(--primary);
        font-size: 0.72rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        font-weight: 700;
      }}
      .hero-copy h1 {{
        margin: 12px 0 10px;
        font-size: clamp(2.4rem, 5vw, 4.2rem);
        line-height: 0.95;
        letter-spacing: -0.06em;
      }}
      .hero-copy p {{
        margin: 0;
        color: var(--muted);
        max-width: 36ch;
        line-height: 1.55;
      }}
      .graph-stage {{
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }}
      .graph {{
        position: relative;
        width: min(950px, calc(100% - 180px));
        height: min(640px, calc(100% - 140px));
      }}
      .graph svg {{
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }}
      .graph-line {{
        stroke: rgba(72, 72, 71, 0.45);
        stroke-width: 1.4;
      }}
      .center-node, .node {{
        position: absolute;
        transform: translate(-50%, -50%);
        background: var(--surface-mid);
        display: flex;
        align-items: center;
        justify-content: center;
      }}
      .center-node {{
        left: 50%;
        top: 50%;
        width: 118px;
        height: 118px;
        border-radius: 999px;
        border: 2px solid var(--primary);
        box-shadow: 0 0 0 10px rgba(141, 237, 236, 0.04);
      }}
      .center-node .center-label {{
        position: absolute;
        top: calc(100% + 14px);
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700;
        letter-spacing: -0.02em;
        text-transform: uppercase;
        font-size: 0.95rem;
      }}
      .node {{
        width: 78px;
        height: 78px;
        border-radius: 999px;
        border: 2px solid var(--primary);
      }}
      .node.warning {{ border-color: var(--warning); }}
      .node.error {{ border-color: var(--error); }}
      .node-label {{
        position: absolute;
        top: calc(100% + 10px);
        width: 140px;
        left: 50%;
        transform: translateX(-50%);
        text-align: center;
      }}
      .node-role {{
        margin-top: 4px;
        color: var(--muted);
        font-size: 0.68rem;
      }}
      .node-status-dot {{
        position: absolute;
        top: 10px;
        right: 10px;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: currentColor;
        box-shadow: 0 0 12px currentColor;
      }}
      .overlay-left {{
        position: absolute;
        top: 94px;
        left: 0;
        width: 320px;
        z-index: 3;
      }}
      .overlay-right {{
        position: absolute;
        top: 12px;
        right: 0;
        width: 320px;
        z-index: 3;
      }}
      .legend {{
        background: rgba(32, 32, 31, 0.58);
        backdrop-filter: blur(18px);
        border-radius: 12px;
        padding: 14px 16px;
        margin-bottom: 16px;
      }}
      .legend h3 {{
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 0.66rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }}
      .legend-row {{
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 0.84rem;
        color: var(--muted);
        margin-bottom: 8px;
      }}
      .bottom-stats {{
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 18px;
        z-index: 3;
      }}
      .stat-card {{
        background: rgba(32, 32, 31, 0.62);
        backdrop-filter: blur(16px);
        padding: 18px;
        border-radius: 12px;
      }}
      .label {{
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.66rem;
        margin-bottom: 8px;
      }}
      .value {{
        font-family: 'Space Grotesk', sans-serif;
        font-size: 2rem;
        font-weight: 700;
      }}
      .value.primary {{ color: var(--primary); }}
      .value.success {{ color: var(--success); }}
      .value.error {{ color: var(--error); }}
      .item-card {{
        background: var(--surface-high);
        border-radius: 10px;
        padding: 14px;
        margin-bottom: 12px;
      }}
      .item-card:last-child {{ margin-bottom: 0; }}
      .item-top {{
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }}
      .item-name {{
        font-weight: 700;
        color: var(--ink);
      }}
      .muted {{ color: var(--muted); }}
      .tag {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 24px;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(141, 237, 236, 0.12);
        color: var(--primary);
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        text-decoration: none;
        margin-right: 6px;
        margin-top: 8px;
      }}
      .tag.success {{ background: rgba(120, 239, 154, 0.12); color: var(--success); }}
      .tag.warning {{ background: rgba(245, 166, 35, 0.12); color: var(--warning); }}
      .tag.error {{ background: rgba(255, 113, 108, 0.12); color: var(--error); }}
      .grid-2 {{
        display: grid;
        grid-template-columns: 1.15fr 0.85fr;
        gap: 18px;
      }}
      .grid-3 {{
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 18px;
      }}
      .stack {{ display: grid; gap: 18px; }}
      .table {{
        display: grid;
        gap: 12px;
      }}
      .table-row {{
        display: grid;
        grid-template-columns: 1.1fr 0.8fr 0.8fr 0.8fr auto;
        gap: 14px;
        align-items: center;
        padding: 14px 16px;
        border-radius: 10px;
        background: var(--surface-high);
      }}
      .actions {{
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }}
      .actions a {{
        text-decoration: none;
        color: var(--primary);
        font-size: 0.82rem;
      }}
      .kpi-grid {{
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 16px;
      }}
      .kpi {{
        background: var(--surface-low);
        border-radius: 12px;
        padding: 18px;
      }}
      .log-stream {{
        background: #090909;
        border-radius: 12px;
        padding: 16px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.82rem;
        line-height: 1.65;
        max-height: 520px;
        overflow: auto;
      }}
      .log-line {{ color: var(--muted); margin-bottom: 6px; }}
      .log-line strong {{ color: var(--primary); font-weight: 600; }}
      .mobile-only {{ display: none; }}
      .desktop-only {{ display: block; }}
      .mobile-shell {{
        min-height: 100vh;
        padding: 18px 16px 108px;
      }}
      .mobile-header {{
        position: sticky;
        top: 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        height: 68px;
        background: rgba(14, 14, 14, 0.92);
        backdrop-filter: blur(16px);
        z-index: 6;
      }}
      .mobile-card {{
        background: var(--surface-low);
        border-radius: 16px;
        padding: 16px;
        margin-top: 14px;
      }}
      .mobile-grid {{
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: 12px;
      }}
      .mobile-metric {{
        background: var(--surface-mid);
        border-radius: 12px;
        padding: 14px;
      }}
      .mobile-list {{ display: grid; gap: 10px; }}
      .mobile-item {{
        background: var(--surface-mid);
        border-radius: 12px;
        padding: 14px;
      }}
      .fab {{
        position: fixed;
        right: 18px;
        bottom: 88px;
        width: 58px;
        height: 58px;
        border-radius: 18px;
        background: linear-gradient(135deg, var(--primary), var(--primary-container));
        color: #002828;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 2rem;
        text-decoration: none;
        z-index: 8;
      }}
      .mobile-nav {{
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(14, 14, 14, 0.88);
        backdrop-filter: blur(18px);
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        padding: 12px 14px 24px;
        z-index: 7;
      }}
      .mobile-tab {{
        color: #7f7f7f;
        text-align: center;
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        padding: 8px 4px;
        border-radius: 12px;
        text-decoration: none;
      }}
      .mobile-tab.active {{
        background: rgba(141, 237, 236, 0.1);
        color: var(--primary);
      }}
      @media (max-width: 1100px) {{
        .grid-2, .grid-3, .kpi-grid {{
          grid-template-columns: 1fr;
        }}
        .table-row {{
          grid-template-columns: 1fr;
        }}
      }}
      @media (max-width: 980px) {{
        .desktop-only {{ display: none; }}
        .mobile-only {{ display: block; }}
      }}
    </style>
  </head>
  <body>
    <div class="app desktop-only">
      {_render_topbar(active, summary.get("filters", {}))}
      <div class="shell">
        {_render_sidebar(active)}
        <main class="workspace">
          <div class="workspace-inner">
            {content}
          </div>
        </main>
      </div>
    </div>

    <div class="mobile-only">
      {_render_mobile_page(summary, active, container_name, service_filter)}
    </div>

    <script>
      const summary = {data};
      const activePage = {json.dumps(active)};
      const activeContainer = {json.dumps(active_container)};
      const activeService = {json.dumps(active_service)};

      const statusClass = (status) => {{
        if (status === "running") return "running";
        if (status === "warning" || status === "replicating") return "warning";
        return "error";
      }};

      const renderGraphInto = (lineId, nodeId) => {{
        const lineTarget = document.getElementById(lineId);
        const nodeTarget = document.getElementById(nodeId);
        if (!lineTarget || !nodeTarget) return;

        lineTarget.innerHTML = summary.topology.lines.map((line) => `
          <line class="graph-line" x1="${{line.x1}}" y1="${{line.y1}}" x2="${{line.x2}}" y2="${{line.y2}}"></line>
        `).join("");

        nodeTarget.innerHTML = summary.topology.nodes.map((node) => `
          <a href="/containers/${{node.name}}" class="node ${{statusClass(node.status)}}" style="left:${{node.x}}%; top:${{node.y}}%; text-decoration:none;">
            <span class="node-status-dot"></span>
            <div class="node-label">
              <div class="headline">${{node.name}}</div>
              <div class="node-role">${{node.role}}</div>
            </div>
          </a>
        `).join("");
      }};

      renderGraphInto("graph-lines", "graph-nodes");
      renderGraphInto("mobile-graph-lines", "mobile-graph-nodes");
    </script>
  </body>
</html>"""


def _render_topbar(active: str, filters: Dict[str, str]) -> str:
    search_value = escape(filters.get("q", ""))
    search_target = {
        "dashboard": "/",
        "containers": "/containers",
        "images": "/images",
        "networks": "/networks",
        "volumes": "/volumes",
        "logs": "/logs",
    }.get(active, "/")
    links = [
        ("/", "dashboard", "Dashboard"),
        ("/images", "images", "Images"),
        ("/containers", "containers", "Containers"),
        ("/images?filter=in-use", "registry", "Registry"),
    ]
    nav = "".join(
        f'<a href="{href}" class="{ "active" if active == key else "" }">{label}</a>'
        for href, key, label in links
    )
    return f"""
    <header class="topbar">
      <div class="topbar-left">
        <a class="brand" href="/">DockerMap</a>
        <nav class="topnav">{nav}</nav>
      </div>
      <div class="topbar-right" style="gap: 14px;">
        <form class="search" action="{search_target}" method="get">
          <span class="mono">Q</span>
          <input type="text" name="q" value="{search_value}" placeholder="Search active page..." />
        </form>
        <a class="ghost-btn" href="/containers?status=running">Filter by Stack</a>
        <a class="icon-btn" href="/logs">≣</a>
        <a class="icon-btn" href="/health">●</a>
      </div>
    </header>
    """


def _render_sidebar(active: str) -> str:
    items = [
        ("/containers", "containers", "◉ Containers"),
        ("/networks", "networks", "◎ Networks"),
        ("/volumes", "volumes", "▣ Volumes"),
        ("/images", "images", "◌ Images"),
        ("/logs", "logs", "≣ Logs"),
    ]
    nav = "".join(
        f'<a href="{href}" class="nav-item {"active" if active == key else ""}">{label}</a>'
        for href, key, label in items
    )
    return f"""
    <aside class="sidebar">
      <div class="engine-card">
        <span class="dot running"></span>
        <div class="engine-meta mono">ENGINE_01</div>
        <div class="engine-state">Running</div>
      </div>
      <nav class="nav-stack">{nav}</nav>
      <a class="primary-btn" href="/containers?status=running">+ Deploy New</a>
      <div class="sidebar-footer">
        <a href="/docs">Docs</a>
        <a href="/logs">Support</a>
      </div>
    </aside>
    """


def _render_page_content(
    summary: Dict[str, Any],
    active: str,
    container_name: Optional[str],
    service_filter: Optional[str],
) -> str:
    if active == "dashboard":
        return _render_dashboard(summary)
    if active == "containers":
        if container_name:
            container = next(
                (item for item in summary["containers"] if item["name"] == container_name),
                None,
            )
            return _render_container_detail(summary, container) if container else _render_not_found()
        return _render_containers(summary)
    if active == "images":
        return _render_images(summary)
    if active == "networks":
        return _render_networks(summary)
    if active == "volumes":
        return _render_volumes(summary)
    if active == "logs":
        return _render_logs(summary, service_filter)
    return _render_not_found()


def _render_dashboard(summary: Dict[str, Any]) -> str:
    left_images = "".join(_render_image_card(image) for image in summary["images"][:3])
    right_networks = "".join(_render_network_card(network) for network in summary["networks"])
    return f"""
    <section class="hero-grid">
      <div class="hero-copy">
        <div class="eyebrow">Kinetic Engine Overview</div>
        <h1 class="headline">Live container topology for the active engine.</h1>
        <p>Review container dependencies, shared images, and network zones in one operational workspace. This mock is powered by DockerMap sample data.</p>
      </div>

      <div class="overlay-left">
        <div class="panel">
          <h2 class="panel-title">Image Inventory</h2>
          {left_images}
        </div>
      </div>

      <div class="overlay-right">
        <div class="legend">
          <h3>Status Legend</h3>
          <div class="legend-row"><span class="dot running"></span>Running</div>
          <div class="legend-row"><span class="dot warning"></span>Replicating</div>
          <div class="legend-row"><span class="dot error"></span>Stopped</div>
        </div>
        <div class="panel">
          <h2 class="panel-title">Network Zones</h2>
          {right_networks}
        </div>
      </div>

      <div class="graph-stage">
        <div class="graph">
          <svg id="graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
          <div class="center-node">
            <div class="center-label">dockermap-cluster</div>
          </div>
          <div id="graph-nodes"></div>
        </div>
      </div>

      <div class="bottom-stats">
        {_render_stat_card("Total Containers", str(summary["stats"]["containers"]), "primary")}
        {_render_stat_card("Image Inventory", str(summary["stats"]["images"]), "success")}
        {_render_stat_card("Network Zones", str(summary["stats"]["networks"]), "")}
        {_render_stat_card("Dependency Links", str(summary["stats"]["dependencies"]), "error")}
      </div>
    </section>
    """


def _render_containers(summary: Dict[str, Any]) -> str:
    filters = summary.get("filters", {})
    rows = []
    for container in summary["containers"]:
        status_chip = _render_status_tag(container["status"])
        ports = _render_port_tags(container["ports"])
        networks = " ".join(
            f'<a class="tag" href="/networks?network={escape(network)}">{escape(network.replace("network_", ""))}</a>'
            for network in container["networks"]
        )
        rows.append(
            f"""
            <div class="table-row">
              <div>
                <div class="item-name headline">{escape(container["name"])}</div>
                <div class="muted">{escape(container["role"])}</div>
              </div>
              <div class="mono">{escape(container["image"])}</div>
              <div>{status_chip}</div>
              <div>{networks}</div>
              <div class="actions">
                <a href="/containers/{escape(container["name"])}">Inspect</a>
                <a href="/logs?service={escape(container["name"])}">Logs</a>
              </div>
              <div>{ports}</div>
            </div>
            """
        )
    return f"""
    <section>
      <div class="page-header">
        <div>
          <h1 class="headline">Container Registry</h1>
          <p>Review service health, image lineage, network membership, and jump directly into a single container or its logs.</p>
        </div>
        <a class="ghost-btn" id="deploy" href="/containers/api">Open API Service</a>
      </div>
      <div class="panel" style="margin-bottom:18px;">
        <h2 class="panel-title">Filters</h2>
        <div>
          <a class="tag {'success' if filters.get('status') == 'running' else ''}" href="/containers?status=running">Running</a>
          <a class="tag {'success' if filters.get('network') == 'network_data' else ''}" href="/containers?network=network_data">Data Network</a>
          <a class="tag {'success' if filters.get('image') == 'python:3.11-slim' else ''}" href="/containers?image=python:3.11-slim">Python Image</a>
          <a class="tag {'success' if filters.get('sort') == 'image' else ''}" href="/containers?sort=image">Sort by Image</a>
          <a class="tag" href="/containers">Clear</a>
        </div>
      </div>
      <div class="kpi-grid">
        {_render_kpi("Running", str(summary["status"]["running"]))}
        {_render_kpi("Warning", str(summary["status"]["warning"]))}
        {_render_kpi("Images", str(summary["stats"]["images"]))}
        {_render_kpi("Volumes", str(summary["stats"]["volumes"]))}
      </div>
      <div class="panel" style="margin-top:18px;">
        <h2 class="panel-title">Containers</h2>
        <div class="table">{''.join(rows)}</div>
      </div>
    </section>
    """


def _render_container_detail(summary: Dict[str, Any], container: Dict[str, Any]) -> str:
    networks = "".join(
        f'<a class="tag" href="/networks?network={escape(network)}">{escape(network.replace("network_", ""))}</a>'
        for network in container["networks"]
    )
    mounts = "".join(
        f'<div class="item-card"><div class="item-name mono">{escape(mount["destination"])}</div><div class="muted"><a href="/volumes?volume={escape(mount["volumeId"])}">{escape(mount["volumeId"].replace("volume_", ""))}</a></div></div>'
        for mount in container["mounts"]
    ) or '<div class="item-card muted">No mounted volumes</div>'
    dependencies = "".join(
        f'<a class="tag" href="/containers/{escape(dep)}">{escape(dep)}</a>'
        for dep in container["depends_on"]
    ) or '<span class="muted">No upstream dependencies</span>'
    logs = "".join(
        f'<div class="log-line"><strong>{escape(line["timestamp"])}</strong> {escape(line["message"])}</div>'
        for line in container["logs"]
    )
    return f"""
    <section class="stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Container Detail</div>
          <h1 class="headline">{escape(container["name"])}</h1>
          <p>{escape(container["role"])} · {escape(container["image"])}</p>
        </div>
        <div class="actions">
          <a class="ghost-btn" href="/containers">Back to Containers</a>
          <a class="ghost-btn" href="/logs?service={escape(container["name"])}">Open Logs</a>
        </div>
      </div>
      <div class="kpi-grid">
        {_render_kpi("CPU", f'{container["cpu"]}%')}
        {_render_kpi("Memory", f'{container["memory"]}%')}
        {_render_kpi("Ports", str(len(container["ports"])))}
        {_render_kpi("Networks", str(len(container["networks"])))}
      </div>
      <div class="grid-2">
        <div class="panel">
          <h2 class="panel-title">Connectivity</h2>
          <div class="label">Networks</div>
          <div>{networks}</div>
          <div class="label" style="margin-top:18px;">Dependencies</div>
          <div>{dependencies}</div>
          <div class="label" style="margin-top:18px;">Exposed Ports</div>
          <div>{_render_port_tags(container["ports"])}</div>
        </div>
        <div class="panel">
          <h2 class="panel-title">Mounted Volumes</h2>
          {mounts}
        </div>
      </div>
      <div class="panel">
        <h2 class="panel-title">Recent Log Stream</h2>
        <div class="log-stream">{logs}</div>
      </div>
    </section>
    """


def _render_images(summary: Dict[str, Any]) -> str:
    filters = summary.get("filters", {})
    cards = "".join(_render_image_inventory_card(image) for image in summary["images"])
    registry_rows = "".join(
        f'<div class="item-card" id="registry-sync"><div class="item-top"><div class="item-name">{escape(label)}</div>{_render_status_tag(state)}</div></div>'
        for label, state in [
            ("Docker Hub", summary["registry"]["docker_hub"]),
            ("GHCR", summary["registry"]["ghcr"]),
            ("Private ACR", summary["registry"]["private_acr"]),
        ]
    )
    return f"""
    <section class="stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Image Inventory</div>
          <h1 class="headline">Manage local image layers and registry sync.</h1>
          <p>Inspect which services are using each image and track registry connectivity from the same workspace.</p>
        </div>
        <a class="ghost-btn" href="/containers">Deploy Container</a>
      </div>
      <div class="panel">
        <h2 class="panel-title">Filters</h2>
        <div>
          <a class="tag {'success' if filters.get('filter') == 'in-use' else ''}" href="/images?filter=in-use">In Use</a>
          <a class="tag {'success' if filters.get('sort') == 'size' else ''}" href="/images?sort=size">Sort by Size</a>
          <a class="tag {'success' if filters.get('image') == 'python:3.11-slim' else ''}" href="/images?image=python:3.11-slim">Python Runtime</a>
          <a class="tag" href="/images">Clear</a>
        </div>
      </div>
      <div class="kpi-grid">
        {_render_kpi("Total Images", str(summary["stats"]["images"]))}
        {_render_kpi("Containers Using Images", str(summary["stats"]["containers"]))}
        {_render_kpi("Unused Layers", "1")}
        {_render_kpi("Active Pulls", "0")}
      </div>
      <div class="grid-2">
        <div class="panel">
          <h2 class="panel-title">Image Cards</h2>
          {cards}
        </div>
        <div class="panel">
          <h2 class="panel-title">Registry Sync Status</h2>
          {registry_rows}
        </div>
      </div>
    </section>
    """


def _render_networks(summary: Dict[str, Any]) -> str:
    filters = summary.get("filters", {})
    cards = "".join(
        f"""
        <article class="item-card" id="{escape(network["id"])}">
          <div class="item-top">
            <div>
              <div class="item-name headline">{escape(network["name"])}</div>
              <div class="muted">{escape(network["driver"])} · {escape(network["scope"])} · {escape(network["traffic"])}</div>
            </div>
            <span class="tag {'warning' if network['internal'] else 'success'}">{'internal' if network['internal'] else 'public'}</span>
          </div>
          <div style="margin-top:10px;">
            {''.join(f'<a class="tag" href="/containers/{escape(member)}">{escape(member)}</a>' for member in network["members"]) or '<span class="muted">No member containers</span>'}
          </div>
        </article>
        """
        for network in summary["networks"]
    )
    return f"""
    <section class="stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Network Topology</div>
          <h1 class="headline">Trace how containers move through edge, app, and data zones.</h1>
          <p>Every network is aligned to the dashboard topology and links straight back to the services using it.</p>
        </div>
        <a class="ghost-btn" href="/">Open Graph</a>
      </div>
      <div class="panel">
        <h2 class="panel-title">Filters</h2>
        <div>
          <a class="tag {'success' if filters.get('network') == 'network_data' else ''}" href="/networks?network=network_data">Focus Data</a>
          <a class="tag {'success' if filters.get('filter') == 'internal' else ''}" href="/networks?filter=internal">Internal</a>
          <a class="tag {'success' if filters.get('sort') == 'traffic' else ''}" href="/networks?sort=traffic">Sort by Traffic</a>
          <a class="tag" href="/networks">Clear</a>
        </div>
      </div>
      <div class="grid-3">{cards}</div>
    </section>
    """


def _render_volumes(summary: Dict[str, Any]) -> str:
    filters = summary.get("filters", {})
    cards = []
    for volume in summary["volumes"]:
        attached = "".join(
            f'<a class="tag" href="/containers/{escape(item["container"])}">{escape(item["container"])}</a>'
            for item in volume["usage"]
        ) or '<span class="muted">No attached services</span>'
        cards.append(
            f"""
            <article class="item-card">
              <div class="item-top">
                <div>
                  <div class="item-name headline">{escape(volume["name"])}</div>
                  <div class="muted">{escape(volume["driver"])} · {escape(volume["capacity"])} provisioned</div>
                </div>
                <span class="tag">{volume["attached"]} attached</span>
              </div>
              <div class="muted mono" style="margin-top:10px;">{escape(volume["mountpoint"])}</div>
              <div style="margin-top:10px;">{attached}</div>
            </article>
            """
        )
    return f"""
    <section class="stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Persistent Storage</div>
          <h1 class="headline">Track which services are writing to each mounted volume.</h1>
          <p>Volume cards stay linked to the containers page so storage paths always connect back to workloads.</p>
        </div>
        <a class="ghost-btn" href="/containers">View Mount Sources</a>
      </div>
      <div class="panel">
        <h2 class="panel-title">Filters</h2>
        <div>
          <a class="tag {'success' if filters.get('volume') == 'volume_postgres_data' else ''}" href="/volumes?volume=volume_postgres_data">Focus Postgres</a>
          <a class="tag {'success' if filters.get('filter') == 'unused' else ''}" href="/volumes?filter=unused">Unused</a>
          <a class="tag {'success' if filters.get('sort') == 'attached' else ''}" href="/volumes?sort=attached">Sort by Attached</a>
          <a class="tag" href="/volumes">Clear</a>
        </div>
      </div>
      <div class="grid-2">{''.join(cards)}</div>
    </section>
    """


def _render_logs(summary: Dict[str, Any], service_filter: Optional[str]) -> str:
    filters = summary.get("filters", {})
    chips = "".join(
        f'<a class="tag {"success" if service_filter == container["name"] else ""}" href="/logs?service={escape(container["name"])}">{escape(container["name"])}</a>'
        for container in summary["containers"]
    )
    if service_filter:
        containers = [c for c in summary["containers"] if c["name"] == service_filter]
    else:
        containers = summary["containers"]
    lines = []
    for container in containers:
        for line in container["logs"]:
            lines.append(
                f'<div class="log-line"><strong>{escape(line["timestamp"])}</strong> [{escape(container["name"])}] {escape(line["message"])}</div>'
            )
    return f"""
    <section class="stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Log Stream</div>
          <h1 class="headline">Inspect live service events across the current stack.</h1>
          <p>Filter by service, jump back to container detail, and keep diagnostics inside the same shell.</p>
        </div>
        <a class="ghost-btn" href="/containers">Back to Containers</a>
      </div>
      <div class="panel">
        <h2 class="panel-title">Quick Filters</h2>
        <div>
          {chips}
          <a class="tag {'success' if filters.get('q') else ''}" href="/logs?q=cache">Search cache</a>
          <a class="tag" href="/logs">All services</a>
        </div>
      </div>
      <div class="panel">
        <h2 class="panel-title">Streaming Output</h2>
        <div class="log-stream">{''.join(lines)}</div>
      </div>
    </section>
    """


def _render_not_found() -> str:
    return """
    <section class="panel">
      <h1 class="headline">Not Found</h1>
      <p class="muted">The requested mock page could not be resolved.</p>
    </section>
    """


def _render_mobile_page(
    summary: Dict[str, Any],
    active: str,
    container_name: Optional[str],
    service_filter: Optional[str],
) -> str:
    if active == "dashboard":
        body = f"""
        <section class="mobile-card">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="dot running"></span>
              <strong class="headline">Status Summary</strong>
            </div>
            <span class="muted">⌃</span>
          </div>
          <div class="mobile-grid">
            {_render_mobile_metric("Containers", str(summary["stats"]["containers"]))}
            {_render_mobile_metric("Images", str(summary["stats"]["images"]))}
            {_render_mobile_metric("Networks", str(summary["stats"]["networks"]))}
            {_render_mobile_metric("Dependencies", str(summary["stats"]["dependencies"]))}
          </div>
        </section>
        <section class="mobile-card">
          <h2 class="panel-title">Cluster Graph</h2>
          <div style="position:relative;height:320px;">
            <div class="graph" style="width:100%;height:100%;">
              <svg id="mobile-graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
              <div class="center-node" style="left:50%;top:50%;width:96px;height:96px;">
                <div class="center-label" style="font-size:.78rem;">Cluster</div>
              </div>
              <div id="mobile-graph-nodes"></div>
            </div>
          </div>
        </section>
        """
    elif active == "containers" and not container_name:
        items = "".join(
            f'<article class="mobile-item"><div class="item-top"><div><div class="item-name headline">{escape(container["name"])}</div><div class="muted">{escape(container["image"])}</div></div>{_render_status_tag(container["status"])}</div><div class="actions" style="margin-top:12px;"><a href="/containers/{escape(container["name"])}">Inspect</a><a href="/logs?service={escape(container["name"])}">Logs</a></div></article>'
            for container in summary["containers"]
        )
        body = f'<section class="mobile-card"><h1 class="headline">Containers</h1><div class="mobile-list">{items}</div></section>'
    elif active == "containers" and container_name:
        container = next((c for c in summary["containers"] if c["name"] == container_name), None)
        if not container:
            body = '<section class="mobile-card"><h1 class="headline">Container not found</h1></section>'
        else:
            body = f"""
            <section class="mobile-card">
              <div class="eyebrow">Container Detail</div>
              <h1 class="headline" style="margin:8px 0 10px;">{escape(container["name"])}</h1>
              <div class="muted">{escape(container["role"])} · {escape(container["image"])}</div>
              <div class="mobile-grid">
                {_render_mobile_metric("CPU", f'{container["cpu"]}%')}
                {_render_mobile_metric("Memory", f'{container["memory"]}%')}
              </div>
              <div style="margin-top:12px;">{''.join(f'<a class="tag" href="/logs?service={escape(container["name"])}">logs</a>' for _ in [0])}</div>
            </section>
            """
    elif active == "images":
        items = "".join(
            f'<article class="mobile-item"><div class="item-name mono">{escape(image["image"])}</div><div class="muted">{image["container_count"]} containers</div></article>'
            for image in summary["images"]
        )
        body = f'<section class="mobile-card"><h1 class="headline">Images</h1><div class="mobile-list">{items}</div></section>'
    elif active == "networks":
        items = "".join(
            f'<article class="mobile-item"><div class="item-name headline">{escape(network["name"])}</div><div class="muted">{escape(network["traffic"])}</div></article>'
            for network in summary["networks"]
        )
        body = f'<section class="mobile-card"><h1 class="headline">Networks</h1><div class="mobile-list">{items}</div></section>'
    elif active == "volumes":
        items = "".join(
            f'<article class="mobile-item"><div class="item-name headline">{escape(volume["name"])}</div><div class="muted">{escape(volume["capacity"])}</div></article>'
            for volume in summary["volumes"]
        )
        body = f'<section class="mobile-card"><h1 class="headline">Volumes</h1><div class="mobile-list">{items}</div></section>'
    else:
        body = f"""
        <section class="mobile-card">
          <h1 class="headline">Logs</h1>
          <div class="mobile-list">
            {''.join(f'<article class="mobile-item"><div class="item-name">{escape(container["name"])}</div><div class="muted">{escape(container["logs"][0]["message"])}</div></article>' for container in summary["containers"] if not service_filter or container["name"] == service_filter)}
          </div>
        </section>
        """

    return f"""
    <div class="mobile-shell">
      <header class="mobile-header">
        <a class="brand" href="/">DockerMap</a>
        <div style="display:flex; gap:12px; align-items:center;">
          <a class="icon-btn" href="/logs">≣</a>
          <a class="icon-btn" href="/health">●</a>
        </div>
      </header>
      {body}
    </div>
    <a class="fab" href="/containers?status=running">+</a>
    <nav class="mobile-nav">
      <a class="mobile-tab {'active' if active == 'dashboard' else ''}" href="/">Graph</a>
      <a class="mobile-tab {'active' if active == 'containers' else ''}" href="/containers">Containers</a>
      <a class="mobile-tab {'active' if active == 'networks' else ''}" href="/networks">Networks</a>
      <a class="mobile-tab {'active' if active == 'logs' else ''}" href="/logs">Logs</a>
    </nav>
    """


def _render_image_card(image: Dict[str, Any]) -> str:
    return f"""
    <article class="item-card">
      <div class="item-top">
        <div>
          <div class="item-name mono">{escape(image["image"])}</div>
          <div class="muted">{image["container_count"]} container{'s' if image["container_count"] > 1 else ''}</div>
        </div>
        {_render_status_tag(image["status"])}
      </div>
      <div>{''.join(f'<a class="tag" href="/containers/{escape(container)}">{escape(container)}</a>' for container in image["containers"])}</div>
    </article>
    """


def _render_image_inventory_card(image: Dict[str, Any]) -> str:
    return f"""
    <article class="item-card">
      <div class="item-top">
        <div>
          <div class="item-name mono">{escape(image["image"])}</div>
          <div class="muted">ID: {escape(image["id"])} · {escape(image["created"])}</div>
        </div>
        {_render_status_tag(image["status"])}
      </div>
      <div class="muted" style="margin-top:10px;">{escape(image["size"])} · {image["container_count"]} services</div>
      <div>
        {''.join(f'<a class="tag" href="/containers/{escape(container)}">{escape(container)}</a>' for container in image["containers"])}
        {''.join(f'<span class="tag mono">{escape(port)}</span>' for port in image["ports"])}
      </div>
    </article>
    """


def _render_network_card(network: Dict[str, Any]) -> str:
    return f"""
    <article class="item-card" id="{escape(network["id"])}">
      <div class="item-top">
        <div>
          <div class="item-name headline">{escape(network["name"])}</div>
          <div class="muted">{escape(network["driver"])} · {escape(network["traffic"])}</div>
        </div>
        <span class="tag {'warning' if network['internal'] else 'success'}">{'internal' if network['internal'] else 'public'}</span>
      </div>
      <div>{''.join(f'<a class="tag" href="/containers/{escape(member)}">{escape(member)}</a>' for member in network["members"])}</div>
    </article>
    """


def _render_stat_card(label: str, value: str, tone: str) -> str:
    klass = f"value {tone}".strip()
    return f"""
    <div class="stat-card">
      <div class="label">{escape(label)}</div>
      <div class="{klass}">{escape(value)}</div>
    </div>
    """


def _render_kpi(label: str, value: str) -> str:
    return f"""
    <div class="kpi">
      <div class="label">{escape(label)}</div>
      <div class="value primary">{escape(value)}</div>
    </div>
    """


def _render_mobile_metric(label: str, value: str) -> str:
    return f"""
    <div class="mobile-metric">
      <div class="label">{escape(label)}</div>
      <div class="value primary">{escape(value)}</div>
    </div>
    """


def _render_status_tag(status: str) -> str:
    mapping = {
        "running": "success",
        "Connected": "success",
        "warning": "warning",
        "replicating": "warning",
        "Auth Needed": "error",
        "stopped": "error",
    }
    css_class = mapping.get(status, "")
    return f'<span class="tag {css_class}">{escape(status)}</span>'


def _render_port_tags(ports: List[Dict[str, Any]]) -> str:
    if not ports:
        return '<span class="muted">No exposed ports</span>'
    return "".join(
        f'<span class="tag mono">{escape(_format_port(port))}</span>' for port in ports
    )


def _build_logs(name: str, role: str) -> List[Dict[str, str]]:
    return [
        {"timestamp": "22:03:11", "message": f"{name} accepted deployment sync for {role}"},
        {"timestamp": "22:03:18", "message": f"{name} refreshed health probes and route cache"},
        {"timestamp": "22:03:24", "message": f"{name} reported stable resource envelope"},
    ]


def _build_topology_nodes(containers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    nodes = []
    for index, container in enumerate(containers):
        angle = (2 * math.pi * index) / max(len(containers), 1)
        radius = 190 if index % 2 == 0 else 145
        x = round(50 + math.cos(angle - math.pi / 2) * (radius / 6), 2)
        y = round(50 + math.sin(angle - math.pi / 2) * (radius / 6), 2)
        nodes.append(
            {
                "id": container["id"],
                "name": container["name"],
                "role": container["role"],
                "status": container["status"],
                "x": x,
                "y": y,
            }
        )
    return nodes


def _percent_for_name(seed: str, low: int, high: int) -> int:
    spread = max(high - low, 1)
    return low + (sum(ord(char) for char in seed) % spread)


def _short_id(seed: str) -> str:
    return hex(sum(ord(char) for char in seed))[2:12]


def _format_port(port: Dict[str, Any]) -> str:
    return f'{port["hostPort"]}:{port["containerPort"]}/{port["protocol"]}'


def _normalize_active(page: str) -> str:
    if page in {"container_detail", "containers"}:
        return "containers"
    if page == "registry":
        return "images"
    return page


def _page_title(active: str, container_name: Optional[str]) -> str:
    if active == "containers" and container_name:
        return f"DockerMap - {container_name}"
    return f"DockerMap - {active.title()}"
