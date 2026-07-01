import { writeFileSync } from "fs"
import { join, resolve } from "path"
import { execSync } from "child_process"
import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, toIRNodeType } from "@kidkender/archmind-protocol"
import { parseProject, requireProject } from "../utils/parse-project.js"

// ---------------------------------------------------------------------------
// Lazy import explainer (optional dep — visualize still works without findings)
// ---------------------------------------------------------------------------

function tryExplain(graph: IntermediateExecutionGraph): Finding[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { explain } = require("@kidkender/archmind-explainer") as { explain: (g: IntermediateExecutionGraph) => Finding[] }
    return explain(graph)
  } catch {
    return []
  }
}

interface Finding {
  type:     string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  summary:  string
  provenance?: { supporting_nodes?: string[] }
}

// ---------------------------------------------------------------------------
// Layer definitions — execution order, top to bottom
// ---------------------------------------------------------------------------

interface LayerDef {
  key:    string
  label:  string
  icon:   string
  color:  string
  types:  string[]
}

const LAYERS: LayerDef[] = [
  { key: "auth",       label: "Authentication",   icon: "🔐", color: "#22c55e", types: [IR_NODE_TYPES.AUTH_GATE] },
  { key: "authz",      label: "Authorization",    icon: "🛡",  color: "#3b82f6", types: [IR_NODE_TYPES.AUTHZ_CHECK, IR_NODE_TYPES.PERMISSION_CONSTANT] },
  { key: "validation", label: "Validation",       icon: "✓",  color: "#06b6d4", types: [IR_NODE_TYPES.VALIDATION_GATE] },
  { key: "runtime",    label: "Runtime Context",  icon: "⚙",  color: "#a78bfa", types: [IR_NODE_TYPES.RUNTIME_INJECT, IR_NODE_TYPES.RUNTIME_CONSUME, IR_NODE_TYPES.TENANT_CONTEXT] },
  { key: "handler",    label: "Controller",       icon: "📋", color: "#94a3b8", types: [IR_NODE_TYPES.BUSINESS_HANDLER] },
  { key: "txn",        label: "Transaction",      icon: "⚡", color: "#8b5cf6", types: [IR_NODE_TYPES.TXN_BOUNDARY] },
  { key: "services",   label: "Services",         icon: "📦", color: "#6366f1", types: [IR_NODE_TYPES.SERVICE_CALL] },
  { key: "data",       label: "Data Access",      icon: "🗃",  color: "#f59e0b", types: [IR_NODE_TYPES.SCOPED_QUERY, IR_NODE_TYPES.UNSCOPED_QUERY, IR_NODE_TYPES.UNSCOPED_WRITE, IR_NODE_TYPES.TXN_WRITE] },
  { key: "resources",  label: "Resources",        icon: "📄", color: "#64748b", types: [IR_NODE_TYPES.RESOURCE, IR_NODE_TYPES.API_RESOURCE] },
  { key: "escape",     label: "Tx Escapes",       icon: "⛔", color: "#ef4444", types: [IR_NODE_TYPES.TXN_ESCAPE] },
  { key: "async",      label: "Async Dispatch",   icon: "📨", color: "#f97316", types: [IR_NODE_TYPES.QUEUE_JOB, IR_NODE_TYPES.EVENT_DISPATCH] },
  { key: "effects",    label: "Side Effects",     icon: "📧", color: "#ec4899", types: [IR_NODE_TYPES.NOTIFICATION, IR_NODE_TYPES.MAIL] },
]

const TYPE_TO_LAYER = new Map<string, LayerDef>()
for (const layer of LAYERS) {
  for (const type of layer.types) {
    TYPE_TO_LAYER.set(type, layer)
  }
}

// ---------------------------------------------------------------------------
// Data model for the HTML report
// ---------------------------------------------------------------------------

interface NodeData {
  id:        string
  symbol:    string
  type:      string
  layerKey:  string
  isDanger:  boolean
  args:      string[]
}

interface LayerData {
  key:   string
  label: string
  icon:  string
  color: string
  nodes: NodeData[]
}

interface FindingData {
  type:         string
  severity:     string
  summary:      string
  nodeIds:      string[]
}

interface RouteData {
  entrypoint:      string
  method:          string
  path:            string
  hasAuth:         boolean
  hasAuthz:        boolean
  hasTransaction:  boolean
  hasValidation:   boolean
  layers:          LayerData[]
  findings:        FindingData[]
  criticalCount:   number
  highCount:       number
  nodeCount:       number
}

interface ReportData {
  generatedAt:  string
  projectRoot:  string
  routeCount:   number
  criticalTotal: number
  routes:       RouteData[]
}

// ---------------------------------------------------------------------------
// Build report data
// ---------------------------------------------------------------------------

const DANGER_TYPES = new Set([
  IR_NODE_TYPES.UNSCOPED_QUERY,
  IR_NODE_TYPES.UNSCOPED_WRITE,
  IR_NODE_TYPES.TXN_ESCAPE,
])

function buildRouteData(graph: IntermediateExecutionGraph, findings: Finding[]): RouteData {
  const [method = "GET", ...pathParts] = graph.entrypoint.split(" ")
  const path = pathParts.join(" ") || "/"

  // Group nodes by layer
  const layerMap = new Map<string, NodeData[]>()
  for (const layer of LAYERS) layerMap.set(layer.key, [])

  for (const node of graph.nodes) {
    const irType = toIRNodeType(node.type)
    const layer = TYPE_TO_LAYER.get(irType)
    if (!layer) continue
    layerMap.get(layer.key)!.push({
      id:       node.id,
      symbol:   node.symbol,
      type:     irType,
      layerKey: layer.key,
      isDanger: DANGER_TYPES.has(irType as keyof typeof IR_NODE_TYPES),
      args:     (node as ExecutionNode & { args?: string[] }).args ?? [],
    })
  }

  const layers: LayerData[] = LAYERS
    .filter((l) => (layerMap.get(l.key)?.length ?? 0) > 0)
    .map((l) => ({
      key:   l.key,
      label: l.label,
      icon:  l.icon,
      color: l.color,
      nodes: layerMap.get(l.key)!,
    }))

  const findingData: FindingData[] = findings.map((f) => ({
    type:     f.type,
    severity: f.severity,
    summary:  f.summary,
    nodeIds:  f.provenance?.supporting_nodes ?? [],
  }))

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length
  const highCount     = findings.filter((f) => f.severity === "HIGH").length

  return {
    entrypoint:     graph.entrypoint,
    method,
    path,
    hasAuth:        layers.some((l) => l.key === "auth"),
    hasAuthz:       layers.some((l) => l.key === "authz"),
    hasTransaction: layers.some((l) => l.key === "txn"),
    hasValidation:  layers.some((l) => l.key === "validation"),
    layers,
    findings:       findingData,
    criticalCount,
    highCount,
    nodeCount:      graph.nodes.length,
  }
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function renderHTML(data: ReportData): string {
  const json = JSON.stringify(data)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ArchMind — Execution Timeline</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--bg2:#161b22;--bg3:#1c2333;--border:#30363d;
  --text:#e6edf3;--muted:#8b949e;--link:#58a6ff;
  --green:#22c55e;--blue:#3b82f6;--red:#ef4444;--orange:#f97316;
  --yellow:#eab308;--purple:#8b5cf6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
}
body{background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column}
header{
  background:var(--bg2);border-bottom:1px solid var(--border);
  padding:12px 20px;display:flex;align-items:center;gap:16px;flex-shrink:0;
}
header h1{font-size:15px;font-weight:600;color:var(--text)}
header .meta{font-size:12px;color:var(--muted);margin-left:auto;display:flex;gap:16px}
.stat-pill{
  background:var(--bg3);border:1px solid var(--border);
  border-radius:12px;padding:3px 10px;font-size:11px;
}
.stat-pill.crit{border-color:var(--red);color:var(--red)}
#shell{display:flex;flex:1;overflow:hidden}

/* sidebar */
#sidebar{
  width:280px;flex-shrink:0;background:var(--bg2);
  border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;
}
#search{
  padding:10px 12px;border-bottom:1px solid var(--border);flex-shrink:0;
}
#search input{
  width:100%;background:var(--bg3);border:1px solid var(--border);
  border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px;outline:none;
}
#search input:focus{border-color:var(--link)}
#route-list{overflow-y:auto;flex:1}
.route-item{
  padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:8px;
}
.route-item:hover{background:var(--bg3)}
.route-item.active{background:#1d2d3e;border-left:3px solid var(--link)}
.route-item.active{padding-left:9px}
.method{
  font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px;
  flex-shrink:0;min-width:40px;text-align:center;
}
.GET{background:#052e16;color:#4ade80}.POST{background:#1e3a5f;color:#60a5fa}
.PUT,.PATCH{background:#451a03;color:#fb923c}.DELETE{background:#450a0a;color:#f87171}
.route-path{font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sev-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sev-dot.CRITICAL{background:var(--red)}.sev-dot.HIGH{background:var(--orange)}
.sev-dot.MEDIUM{background:var(--yellow)}.sev-dot.ok{background:#374151}

/* main content */
#main{flex:1;overflow-y:auto;padding:24px}
#placeholder{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;color:var(--muted);gap:8px;
}
#route-detail{display:none}
.route-header{margin-bottom:20px}
.route-title{font-size:20px;font-weight:700;display:flex;align-items:center;gap:10px}
.route-title .method{font-size:13px;padding:3px 8px}
.route-badges{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.badge{
  font-size:11px;padding:3px 9px;border-radius:12px;
  border:1px solid;display:flex;align-items:center;gap:4px;
}
.badge.has{border-color:#1a3a1a;background:#052e16;color:#4ade80}
.badge.missing{border-color:#3a1a1a;background:#1c0a0a;color:#f87171}
.badge.neutral{border-color:var(--border);background:var(--bg3);color:var(--muted)}

/* findings */
.findings-section{margin-bottom:20px}
.findings-title{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.finding-card{
  border:1px solid var(--border);border-radius:8px;padding:10px 12px;
  margin-bottom:6px;display:flex;gap:10px;align-items:flex-start;
}
.finding-card.CRITICAL{border-color:#7f1d1d;background:#1c0a0a}
.finding-card.HIGH{border-color:#7c2d12;background:#1c0f05}
.finding-card.MEDIUM{border-color:#713f12;background:#1c1405}
.finding-card.LOW{border-color:var(--border)}
.sev-label{
  font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;flex-shrink:0;margin-top:1px;
}
.sev-label.CRITICAL{background:#7f1d1d;color:#fca5a5}
.sev-label.HIGH{background:#7c2d12;color:#fdba74}
.sev-label.MEDIUM{background:#713f12;color:#fde68a}
.sev-label.LOW{background:#1e293b;color:#94a3b8}
.finding-summary{font-size:13px;line-height:1.5}

/* timeline */
.timeline{display:flex;flex-direction:column;gap:0}
.layer{display:flex;gap:0;position:relative}
.layer:not(:last-child)::after{
  content:"";position:absolute;left:19px;top:100%;width:2px;height:8px;
  background:var(--border);z-index:0;
}
.layer-connector{
  display:flex;flex-direction:column;align-items:center;flex-shrink:0;
  width:40px;padding-top:4px;
}
.layer-icon{
  width:32px;height:32px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-size:15px;border:2px solid;flex-shrink:0;
  background:var(--bg2);z-index:1;
}
.layer-line{width:2px;flex:1;background:var(--border);margin-top:4px}
.layer-body{flex:1;padding:4px 0 16px 12px}
.layer-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.node-list{display:flex;flex-direction:column;gap:4px}
.node-chip{
  display:inline-flex;align-items:center;gap:6px;
  background:var(--bg3);border:1px solid var(--border);border-radius:6px;
  padding:5px 10px;font-size:12px;font-family:ui-monospace,monospace;
  max-width:100%;width:fit-content;
}
.node-chip.danger{border-color:#7f1d1d;background:#1c0a0a;color:#fca5a5}
.node-chip .args{color:var(--muted);font-size:11px}
.node-finding-dot{
  width:6px;height:6px;border-radius:50%;flex-shrink:0;
}
.node-finding-dot.CRITICAL{background:var(--red)}
.node-finding-dot.HIGH{background:var(--orange)}
.node-finding-dot.MEDIUM{background:var(--yellow)}

/* empty state */
.empty-layer{color:var(--muted);font-size:12px;font-style:italic}

/* scrollbar */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg2)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<header>
  <h1>⚙ ArchMind — Execution Timeline</h1>
  <div class="meta">
    <span class="stat-pill" id="stat-routes">0 routes</span>
    <span class="stat-pill crit" id="stat-crit" style="display:none">0 critical</span>
    <span class="stat-pill" id="stat-date"></span>
  </div>
</header>
<div id="shell">
  <aside id="sidebar">
    <div id="search"><input id="search-input" type="text" placeholder="Filter routes…"></div>
    <div id="route-list"></div>
  </aside>
  <main id="main">
    <div id="placeholder">
      <div style="font-size:32px">⚙</div>
      <div style="font-size:14px">Select a route to view its execution timeline</div>
    </div>
    <div id="route-detail"></div>
  </main>
</div>

<script>
const DATA = ${json};
let activeIdx = -1;

function methodColor(m){return m}

function severityOrder(s){return{CRITICAL:0,HIGH:1,MEDIUM:2,LOW:3,INFO:4}[s]??5}

function renderRouteList(routes){
  const list = document.getElementById('route-list');
  list.innerHTML='';
  routes.forEach(({route, origIdx})=>{
    const r = DATA.routes[origIdx];
    const sev = r.criticalCount>0?'CRITICAL':r.highCount>0?'HIGH':r.findings.length>0?'MEDIUM':'ok';
    const el = document.createElement('div');
    el.className='route-item';
    el.dataset.idx = origIdx;
    el.innerHTML=\`
      <span class="method \${r.method}">\${r.method}</span>
      <span class="route-path" title="\${r.path}">\${r.path}</span>
      <span class="sev-dot \${sev}"></span>
    \`;
    el.addEventListener('click',()=>selectRoute(origIdx));
    list.appendChild(el);
  });
}

function nodeFindings(nodeId, findings){
  return findings.filter(f=>f.nodeIds.includes(nodeId));
}

function renderTimeline(r){
  if(!r.layers.length) return '<p class="empty-layer">No semantic nodes found in this route.</p>';
  return r.layers.map((layer,li)=>\`
    <div class="layer">
      <div class="layer-connector">
        <div class="layer-icon" style="border-color:\${layer.color};color:\${layer.color}">\${layer.icon}</div>
        \${li<r.layers.length-1?'<div class="layer-line"></div>':''}
      </div>
      <div class="layer-body">
        <div class="layer-label" style="color:\${layer.color}">\${layer.label}</div>
        <div class="node-list">
          \${layer.nodes.map(n=>{
            const nf = nodeFindings(n.id, r.findings);
            const topSev = nf.length? nf.sort((a,b)=>severityOrder(a.severity)-severityOrder(b.severity))[0].severity : null;
            return \`<div class="node-chip\${n.isDanger?' danger':''}">
              \${topSev?\`<span class="node-finding-dot \${topSev}"></span>\`:''}
              <span>\${escHtml(n.symbol)}</span>
              \${n.args&&n.args.length?\`<span class="args">(\${n.args.map(escHtml).join(', ')})</span>\`:''}
            </div>\`;
          }).join('')}
        </div>
      </div>
    </div>
  \`).join('');
}

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function selectRoute(idx){
  activeIdx=idx;
  document.querySelectorAll('.route-item').forEach(el=>{
    el.classList.toggle('active', el.dataset.idx==idx);
  });
  const r = DATA.routes[idx];
  const detail = document.getElementById('route-detail');
  document.getElementById('placeholder').style.display='none';
  detail.style.display='block';

  const badgeAuth = r.hasAuth
    ? '<span class="badge has">🔐 Auth</span>'
    : '<span class="badge missing">🔓 No Auth</span>';
  const badgeAuthz = r.hasAuthz
    ? '<span class="badge has">🛡 Authz</span>'
    : '<span class="badge missing">☐ No Authz</span>';
  const badgeTxn = r.hasTransaction
    ? '<span class="badge has">⚡ Transaction</span>'
    : '<span class="badge neutral">⚡ No Txn</span>';
  const badgeVal = r.hasValidation
    ? '<span class="badge has">✓ Validation</span>'
    : '<span class="badge neutral">✓ No Validation</span>';

  const findingsHtml = r.findings.length? \`
    <div class="findings-section">
      <div class="findings-title">Findings (\${r.findings.length})</div>
      \${[...r.findings].sort((a,b)=>severityOrder(a.severity)-severityOrder(b.severity)).map(f=>\`
        <div class="finding-card \${f.severity}">
          <span class="sev-label \${f.severity}">\${f.severity}</span>
          <span class="finding-summary">\${escHtml(f.summary)}</span>
        </div>
      \`).join('')}
    </div>
  \` : '';

  detail.innerHTML=\`
    <div class="route-header">
      <div class="route-title">
        <span class="method \${r.method}">\${r.method}</span>
        \${escHtml(r.path)}
      </div>
      <div class="route-badges">
        \${badgeAuth}\${badgeAuthz}\${badgeTxn}\${badgeVal}
        <span class="badge neutral">\${r.nodeCount} nodes</span>
      </div>
    </div>
    \${findingsHtml}
    <div class="timeline">\${renderTimeline(r)}</div>
  \`;
}

function init(){
  const d = DATA;
  document.getElementById('stat-routes').textContent = d.routeCount+' routes';
  document.getElementById('stat-date').textContent = new Date(d.generatedAt).toLocaleString();
  if(d.criticalTotal>0){
    const el=document.getElementById('stat-crit');
    el.style.display='';
    el.textContent=d.criticalTotal+' critical';
  }

  let filteredRoutes = d.routes.map((r,i)=>({route:r,origIdx:i}));
  renderRouteList(filteredRoutes);

  document.getElementById('search-input').addEventListener('input',e=>{
    const q=e.target.value.toLowerCase();
    filteredRoutes=d.routes.map((r,i)=>({route:r,origIdx:i}))
      .filter(({route:r})=>r.entrypoint.toLowerCase().includes(q)||r.findings.some(f=>f.summary.toLowerCase().includes(q)));
    renderRouteList(filteredRoutes);
    if(activeIdx>=0 && filteredRoutes.some(x=>x.origIdx===activeIdx)){
      document.querySelector(\`.route-item[data-idx="\${activeIdx}"]\`)?.classList.add('active');
    }
  });

  // Auto-select first route
  if(d.routes.length>0) selectRoute(0);
}

init();
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runVisualize(flags: Record<string, string>): Promise<void> {
  const projectRoot = requireProject(flags)
  const output      = flags["output"] ?? join(process.cwd(), "archmind-report.html")
  const openFlag    = "open" in flags

  const { graphs, routeCount } = parseProject(projectRoot)
  console.log(`Parsed ${routeCount} routes`)

  const routes: RouteData[] = []
  let criticalTotal = 0

  for (const graph of graphs) {
    const findings = tryExplain(graph)
    const route    = buildRouteData(graph, findings)
    routes.push(route)
    criticalTotal += route.criticalCount
  }

  // Sort: critical first, then by method+path
  routes.sort((a, b) => {
    const sc = (b.criticalCount + b.highCount) - (a.criticalCount + a.highCount)
    if (sc !== 0) return sc
    return a.entrypoint.localeCompare(b.entrypoint)
  })

  const data: ReportData = {
    generatedAt:   new Date().toISOString(),
    projectRoot:   resolve(projectRoot),
    routeCount,
    criticalTotal,
    routes,
  }

  const html = renderHTML(data)
  writeFileSync(output, html, "utf-8")
  console.log(`Report written: ${output}`)

  if (criticalTotal > 0) {
    console.log(`  ${criticalTotal} critical finding(s) found`)
  }

  if (openFlag) {
    try {
      const cmd = process.platform === "darwin" ? "open"
                : process.platform === "win32"  ? "start"
                : "xdg-open"
      execSync(`${cmd} "${output}"`)
    } catch {
      // best-effort
    }
  }
}
