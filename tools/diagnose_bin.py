"""Diagnose the bin graph: trace divide x/y, locate subdivision groups, and see
where the 7 unhandled node types sit (active body vs cosmetic)."""
import json, sys
from collections import defaultdict, deque

dump = json.load(open(sys.argv[1]))
groups = dump["node_groups"]

# modifier group
obj = next(o for o in dump["objects"] if o["name"] == "Procedural Drawer")
root = next(m["node_group"] for m in obj["modifiers"] if m.get("node_group"))
print(f"root group: {root}\n")

UNHANDLED = {"GeometryNodeStringToCurves", "GeometryNodeInputMeshEdgeVertices",
             "GeometryNodeInputMeshFaceNeighbors", "GeometryNodeInputMeshEdgeNeighbors",
             "GeometryNodeObjectInfo", "GeometryNodeInputMeshIsland", "GeometryNodeProximity"}

def idx_nodes(g):
    return {n["name"]: n for n in g["nodes"]}

def out_links(g):
    d = defaultdict(list)
    for l in g["links"]:
        d[(l["from_node"], l["from_socket"])].append(l)
    return d

def in_links(g):
    d = defaultdict(list)
    for l in g["links"]:
        d[(l["to_node"], l["to_socket"])].append(l)
    return d

# --- 1. trace divide x / divide y from the root GroupInput -----------------
g = groups[root]
nodes = idx_nodes(g)
outl = out_links(g)
group_inputs = [n for n in g["nodes"] if n["type"] == "NodeGroupInput"]

def iface_id(g, name):
    for it in g["interface"]:
        if it.get("item_type") == "SOCKET" and it.get("in_out") == "INPUT" and it["name"] == name:
            return it["identifier"]
    return None

def T(t):
    return t.replace('GeometryNode', 'GN.').replace('ShaderNode', 'Sh.').replace('FunctionNode', 'Fn.')

for pname in ("divide x", "divide y", "Bin Select"):
    ident = iface_id(g, pname)
    print(f"=== '{pname}' (id {ident}) consumers in {root} (across {len(group_inputs)} GroupInput nodes) ===")
    consumers = []
    for gi in group_inputs:
        consumers += outl.get((gi["name"], ident), [])
    if not consumers:
        print("   (genuinely unused in root)")
    for l in consumers:
        tn = nodes[l["to_node"]]
        grp = f" -> GROUP '{tn.get('group')}'" if tn["type"] == "GeometryNodeGroup" else ""
        print(f"   {T(tn['type'])}  (into socket {l['to_socket']}){grp}   label={tn.get('label')}")
    print()

# --- 2. which groups contain the unhandled node types ----------------------
print("=== unhandled node types by group ===")
loc = defaultdict(lambda: defaultdict(int))
for gname, gg in groups.items():
    for n in gg["nodes"]:
        if n["type"] in UNHANDLED:
            loc[n["type"]][gname] += 1
for t in sorted(loc):
    where = ", ".join(f"{gn}×{c}" for gn, c in loc[t].items())
    print(f"   {t.replace('GeometryNode','GN.')}: {where}")
print()

# --- 2b. readable trace of a group's logic ---------------------------------
def trace_group(gname):
    gg = groups[gname]
    nn = idx_nodes(gg)
    il = in_links(gg)
    print(f"\n===== TRACE: {gname} ({len(gg['nodes'])} nodes) =====")
    # interface
    ins = [it["name"] for it in gg["interface"] if it.get("in_out") == "INPUT" and it.get("item_type") == "SOCKET"]
    outs = [it["name"] for it in gg["interface"] if it.get("in_out") == "OUTPUT" and it.get("item_type") == "SOCKET"]
    print(f"  IN: {ins}\n  OUT: {outs}")
    sid = {}
    def sidof(nm):
        if nm not in sid: sid[nm] = f"n{len(sid)+1}"
        return sid[nm]
    def ref(nm, sock):
        ls = il.get((nm, sock), [])
        if not ls: return None
        return " + ".join(f"{sidof(l['from_node'])}.{l['from_socket']}" for l in ls)
    for n in gg["nodes"]:
        if n["type"] in ("NodeFrame", "NodeReroute"): continue
        head = T(n["type"])
        for p in ("operation", "data_type", "domain", "mode"):
            if n.get("props", {}).get(p) is not None: head += f"[{n['props'][p]}]"
        args = []
        for s in n["inputs"]:
            r = ref(n["name"], s["identifier"])
            if r: args.append(f"{s['name']}={r}")
            elif s.get("value") not in (None, "") and not s.get("linked"):
                v = s["value"]
                if isinstance(v, list): v = "(" + ",".join(str(round(x, 3)) if isinstance(x, (int, float)) else str(x) for x in v) + ")"
                args.append(f"{s['name']}:{v}")
        line = f"  {sidof(n['name'])} = {head}({', '.join(args)})"
        if n.get("label"): line += f"   // {n['label']}"
        print(line)

trace_group("Recursive Subdivision N++.001")

# --- 3. subdivision-ish groups + which unhandled they use ------------------
print("=== groups whose name hints at subdivision / recursion / divide ===")
for gname, gg in groups.items():
    low = gname.lower()
    if any(k in low for k in ("subdiv", "recursiv", "divide", "split", "bin", "cell", "iter")):
        types = defaultdict(int)
        for n in gg["nodes"]:
            types[n["type"]] += 1
        unh = [t for t in types if t in UNHANDLED]
        rnd = types.get("FunctionNodeRandomValue", 0)
        rep = types.get("GeometryNodeRepeatInput", 0)
        print(f"   {gname}: {len(gg['nodes'])} nodes | random={rnd} repeat={rep} | unhandled={[t.replace('GeometryNode','') for t in unh]}")
