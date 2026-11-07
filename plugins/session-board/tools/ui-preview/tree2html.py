import json,re,html,sys
sp=sys.argv[1]
tree=None
for l in open(sp+'/dump.txt'):
    if l.startswith('@@TREE desktop '): tree=json.loads(l[len('@@TREE desktop '):])
SP={'xs':4,'sm':8,'md':12,'lg':16,'xl':24}
sz=lambda v:(SP.get(v,v*4) if isinstance(v,int) else SP.get(v,0)) if v is not None else None
COL={'subtle':'#8b8b8b','warning':'#e5a50a','error':'#f14c4c','claude':'#d97757','success':'#22c55e'}
def col(c): return COL.get(c,c)
def kids(n):
    c=n.get('children'); 
    return c if isinstance(c,list) else ([c] if c is not None else [])
def text(n):
    if isinstance(n,str) or isinstance(n,(int,float)): return html.escape(str(n))
    p=n.get('props',{}); st=[]
    if p.get('color'): st.append(f"color:{col(p['color'])}")
    if p.get('dimColor'): st.append('opacity:.6')
    if p.get('weight') in('bold','semibold'): st.append('font-weight:600')
    st.append('font-size:%dpx'%{'heading':17,'footnote':13,'caption':12}.get(p.get('size'),13))
    if p.get('wrap')=='truncate-end': st.append('white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;max-width:100%;vertical-align:bottom')
    return f"<span style='{';'.join(st)}'>"+''.join(render(k) for k in kids(n))+"</span>"
def render(n):
    if isinstance(n,(str,int,float)): return html.escape(str(n))
    if n is None: return ''
    t=n.get('type');p=n.get('props',{})
    if t=='Text': return text(n)
    if t=='Button':
        label=p.get('label') or ''.join(render(k) for k in kids(n))
        cls='sec' if p.get('variant')=='secondary' else 'btn'
        return f"<button class={cls}>{label}</button>"
    if t=='Input':
        return f"<div class=inp><span>{html.escape(p.get('placeholder') or '')}</span>"+(f"<button class=btn>{p['submitLabel']}</button>" if p.get('submitLabel') else '')+"</div>"
    if t=='Select':
        v=p.get('value');o=[x.get('label') for x in p.get('options',[]) if x.get('value')==v]
        return f"<span class=sel>{html.escape(str(o[0] if o else v))} ▾</span>"
    st=[f"display:flex;flex-direction:{p.get('flexDirection','column')}"]
    if p.get('flexWrap'):st.append('flex-wrap:wrap')
    for a,b in[('gap','gap'),('columnGap','column-gap'),('rowGap','row-gap'),('padding','padding'),('paddingLeft','padding-left'),('marginTop','margin-top')]:
        if p.get(a) is not None: st.append(f"{b}:{sz(p[a])}px")
    if p.get('paddingX') is not None: st.append(f"padding-left:{sz(p['paddingX'])}px;padding-right:{sz(p['paddingX'])}px")
    if p.get('paddingY') is not None: st.append(f"padding-top:{sz(p['paddingY'])}px;padding-bottom:{sz(p['paddingY'])}px")
    if p.get('flexGrow') is not None: st.append(f"flex-grow:{p['flexGrow']}")
    if p.get('flexShrink') is not None: st.append(f"flex-shrink:{p['flexShrink']};min-width:0")
    if p.get('minWidth') is not None: st.append(f"min-width:{p['minWidth']*8}px")
    if p.get('alignItems'): st.append(f"align-items:{p['alignItems']}")
    if p.get('borderStyle'): st.append(f"border:1px solid {col(p.get('borderColor','#555'))};border-radius:8px")
    return f"<div style='{';'.join(st)}'>"+''.join(render(k) for k in kids(n))+"</div>"
page="""<!doctype html><meta charset=utf8><title>board</title><style>
body{margin:0;background:#1e1e1e;color:#ddd;font:13px -apple-system,sans-serif;line-height:1.45}
.btn{background:#0e639c;color:#fff;border:0;border-radius:4px;padding:2px 8px;font-size:12px}
.sec{background:#3a3d41;color:#ddd;border:0;border-radius:4px;padding:2px 8px;font-size:12px}
.inp{display:flex;flex-grow:1;border:1px solid #444;border-radius:4px;padding:2px 2px 2px 6px;justify-content:space-between;color:#888}
.sel{border:1px solid #444;border-radius:4px;padding:0 6px;font-size:12px}
</style>"""+render(tree)
open(sp+'/board-preview.html','w').write(page)
