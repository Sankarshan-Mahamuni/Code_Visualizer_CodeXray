(() => {
  const DEFAULT_CODE = `def fib(n):
    if n <= 1:
        return n

    left = fib(n - 1)
    right = fib(n - 2)
    return left + right

print(fib(5))`;

  const $ = id => document.getElementById(id);
  const state = {
    events: [], step: 0, output: "", playing: false, timer: null,
    frames: new Map(), positions: new Map(),
    zoom: 1, panX: 0, panY: 0, follow: true, panning: false,
    space: false, max: false
  };

  const el = {
    code:$("codeInput"), gutter:$("gutter"), lineHighlight:$("lineHighlight"), currentLine:$("currentLine"),
    run:$("runBtn"), language:$("language"), viewport:$("viewport"), world:$("world"),
    edges:$("edges"), edgeLayer:$("edgeLayer"), nodes:$("nodeLayer"), memoryLayer:$("memoryLayer"),
    empty:$("empty"), eventType:$("eventType"), eventTitle:$("eventTitle"), eventDetail:$("eventDetail"),
    status:$("statusBadge"), stepText:$("stepText"), timelineEvent:$("timelineEvent"), range:$("range"),
    prev:$("prevBtn"), next:$("nextBtn"), play:$("playBtn"), reset:$("resetBtn"), output:$("output"), error:$("error"),
    zoomLabel:$("zoomLabel"), hudZoom:$("hudZoom"), follow:$("followToggle"), visual:$("visualPanel"),
    fit:$("fitBtn"), focus:$("focusBtn"), zoomIn:$("zoomIn"), zoomOut:$("zoomOut"),
    hudFit:$("hudFit"), hudZoomIn:$("hudZoomIn"), hudZoomOut:$("hudZoomOut"),
    max:$("maxBtn"), stackBtn:$("stackBtn"), memoryBtn:$("memoryBtn"),
    stackOverlay:$("stackOverlay"), memoryOverlay:$("memoryOverlay"),
    stackContent:$("stackContent"), memoryContent:$("memoryContent")
  };

  el.code.value = DEFAULT_CODE;

  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));

  function valueText(v) {
    if (v === null || v === undefined) return "None";
    if (typeof v !== "object") return String(v);
    if ("value" in v) return v.value === null ? "None" : String(v.value);
    if (v.objectId) return "→ " + v.objectId;
    if (v.type) return `<${v.type}>`;
    return String(v);
  }

  function stackOf(e) {
    return Array.isArray(e?.callStack) ? e.callStack.map((x, i) => ({
      id:String(x?.frameId ?? `stack_${i}`),
      fn:String(x?.function ?? "<module>")
    })).filter(x => x.id) : [];
  }

  function activeFrameId(e) {
    if (!e) return "";
    if (e.frameId) return String(e.frameId);
    const s = stackOf(e);
    return s.length ? s[s.length - 1].id : "";
  }

  function makeArgs(e) {
    const vars = e?.variables && typeof e.variables === "object" ? e.variables : {};
    const out = {};
    for (const [k,v] of Object.entries(vars)) {
      if (k.startsWith("__") || k === "self") continue;
      out[k] = valueText(v);
    }
    return out;
  }

  /*
    IMPORTANT:
    Frames are reconstructed ONLY from events <= current step.
    A future FUNCTION_ENTER cannot appear before that step.
  */
  function reconstructFrames(step) {
    const frames = new Map();

    const ensure = (id, e, firstStep) => {
      if (!id) return null;
      if (!frames.has(id)) {
        frames.set(id, {
          id, fn:String(e?.function ?? "<module>"), parentId:null,
          firstStep, lastStep:firstStep, enterStep:null, exitStep:null,
          line:Number(e?.line || 0), args:{}, vars:{}, status:"WAITING",
          returnValue:"", lastEvent:""
        });
      }
      return frames.get(id);
    };

    for (let i=0; i<=step && i<state.events.length; i++) {
      const e = state.events[i];
      const stack = stackOf(e);

      // Create frames from the actual runtime stack at this historical step.
      stack.forEach((s, idx) => {
        const f = ensure(s.id, e, i);
        if (!f) return;
        f.fn = s.fn || f.fn;
        f.lastStep = i;
        if (e.line) f.line = Number(e.line);
        if (idx === stack.length - 1) {
          f.args = makeArgs(e);
          f.vars = e.variables || {};
          f.lastEvent = String(e.event || "");
        }
      });

      const id = activeFrameId(e);
      const f = ensure(id, e, i);
      if (f) {
        f.lastStep = i;
        f.fn = String(e.function ?? f.fn);
        f.line = Number(e.line || f.line);
        f.args = makeArgs(e);
        f.vars = e.variables || {};
        f.lastEvent = String(e.event || "");
        if (e.event === "FUNCTION_ENTER") f.enterStep = f.enterStep ?? i;
        if (e.event === "FUNCTION_EXIT") {
          f.exitStep = i;
          const rv = e.returnValue ?? e.returnedValue ?? e.return_value ?? e.value;
          if (rv !== undefined) f.returnValue = valueText(rv);
        }
      }

      // Parent links from the actual runtime stack.
      for (let j=1;j<stack.length;j++) {
        const child = frames.get(stack[j].id);
        const parent = frames.get(stack[j-1].id);
        if (child && parent) child.parentId = parent.id;
      }
    }

    // If a frame was explicitly entered/exited, use those events to update exact lifecycle.
    for (let i=0;i<=step && i<state.events.length;i++) {
      const e=state.events[i], id=activeFrameId(e), f=frames.get(id);
      if (!f) continue;
      if (e.event === "FUNCTION_ENTER") f.enterStep = f.enterStep ?? i;
      if (e.event === "FUNCTION_EXIT") {
        f.exitStep = i;
        const rv=e.returnValue ?? e.returnedValue ?? e.return_value ?? e.value;
        if (rv !== undefined) f.returnValue=valueText(rv);
      }
    }

    const active = activeFrameId(state.events[step]);
    for (const f of frames.values()) {
      if (f.exitStep !== null && f.exitStep <= step) f.status = "RETURNED";
      else if (f.id === active) f.status = "ACTIVE";
      else f.status = "WAITING";
    }
    return frames;
  }

  function buildChildren() {
    for (const f of state.frames.values()) f.children = [];
    for (const f of state.frames.values()) {
      if (f.parentId && state.frames.has(f.parentId)) state.frames.get(f.parentId).children.push(f.id);
    }
    for (const f of state.frames.values()) {
      f.children.sort((a,b) => state.frames.get(a).firstStep - state.frames.get(b).firstStep);
    }
  }

  function branchLabel(parent, child, index) {
    const line = sourceLine(parent.line).trim();
    if (parent.children.length < 2) return "CALL";
    if (/left\\s*=/.test(line)) return index===0 ? "LEFT" : "RIGHT";
    if (/right\\s*=/.test(line)) return index===0 ? "RIGHT" : "LEFT";
    if (/[+*/-]/.test(line)) return index===0 ? "LEFT" : "RIGHT";
    return `BRANCH ${index+1}`;
  }

  function sourceLine(n) {
    const lines=el.code.value.split("\n");
    return lines[Math.max(0, Number(n||1)-1)] || "";
  }

  function layout() {
    state.positions.clear();
    const roots=[...state.frames.values()].filter(f=>!f.parentId || !state.frames.has(f.parentId))
      .sort((a,b)=>a.firstStep-b.firstStep);

    const NODE_W=240, XGAP=55, YGAP=70;
    let cursor=0;

    function walk(id, depth) {
      const f=state.frames.get(id);
      const children=f.children || [];
      if (!children.length) {
        const x=cursor*(NODE_W+XGAP);
        cursor++;
        state.positions.set(id,{x,y:depth*(155+YGAP)});
        return x;
      }
      const xs=children.map(c=>walk(c,depth+1));
      const x=(xs[0]+xs[xs.length-1])/2;
      state.positions.set(id,{x,y:depth*(155+YGAP)});
      return x;
    }
    roots.forEach(r=>walk(r.id,0));
  }

  function frameHtml(f) {
    const args=Object.entries(f.args||{}).filter(([k])=>!k.startsWith("__"));
    const argsText=args.length ? args.map(([k,v])=>`${k}=${v}`).join(", ") : "arguments unavailable";
    const active=f.status==="ACTIVE";
    let note=active ? `Executing line ${f.line}` :
      f.status==="RETURNED" ? "Invocation completed" : "Waiting for child";
    if (f.returnValue) note += `<div class="return">↩ returned ${esc(f.returnValue)}</div>`;
    return `<div class="frame ${f.status.toLowerCase()} ${active?"active":""}" data-frame="${esc(f.id)}">
      <div class="frame-head"><span class="frame-name">${esc(f.fn)}()</span><span class="state">${f.status}</span></div>
      <div class="args"><b>arguments</b><br>${esc(argsText)}</div>
      <div class="meta"><span>frame ${esc(f.id)}</span><span>line ${f.line}</span></div>
      <div class="note">${note}</div>
    </div>`;
  }

  function renderFrames() {
    el.nodes.innerHTML="";
    const frag=document.createDocumentFragment();
    for (const f of state.frames.values()) {
      const p=state.positions.get(f.id); if(!p) continue;
      const d=document.createElement("div");
      d.className="frame-host";
      d.style.cssText=`position:absolute;left:${p.x}px;top:${p.y}px;width:240px;height:155px`;
      d.innerHTML=frameHtml(f);
      d.querySelector(".frame").addEventListener("dblclick",()=>focusFrame(f.id));
      frag.appendChild(d);
    }
    el.nodes.appendChild(frag);
  }

  function renderEdges() {
    const pts=[...state.positions.values()];
    const maxX=Math.max(1000,...pts.map(p=>p.x+240));
    const maxY=Math.max(700,...pts.map(p=>p.y+170));
    el.edges.setAttribute("width",maxX);
    el.edges.setAttribute("height",maxY);
    el.edgeLayer.innerHTML="";
    const ns="http://www.w3.org/2000/svg";
    const active=activeFrameId(state.events[state.step]);

    for (const parent of state.frames.values()) {
      const a=state.positions.get(parent.id); if(!a) continue;
      parent.children.forEach((cid,index)=>{
        const child=state.frames.get(cid), b=state.positions.get(cid);
        if(!child||!b) return;
        const x1=a.x+120,y1=a.y+155,x2=b.x+120,y2=b.y;
        const mid=(y1+y2)/2;
        const path=document.createElementNS(ns,"path");
        path.setAttribute("d",`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`);
        if(parent.id===active||child.id===active) path.classList.add("active");
        el.edgeLayer.appendChild(path);
        const t=document.createElementNS(ns,"text");
        t.setAttribute("x",(x1+x2)/2); t.setAttribute("y",mid-5); t.setAttribute("text-anchor","middle");
        t.textContent=branchLabel(parent,child,index); el.edgeLayer.appendChild(t);
      });
    }
  }

  function renderMemory(e) {
    el.memoryLayer.innerHTML="";
    const objects=e?.objects||{};
    const ids=Object.keys(objects);
    if(!ids.length) return;

    // Put memory below the execution tree.
    const ys=Math.max(520,...[...state.positions.values()].map(p=>p.y+180));
    ids.forEach((id,i)=>{
      const obj=objects[id]||{};
      const d=document.createElement("div");
      d.className="memory-card";
      d.style.left=`${i*240}px`; d.style.top=`${ys}px`;
      const rows=[];
      const source=obj.fields ?? obj.entries;
      if(source && typeof source==="object") {
        for(const [k,v] of Object.entries(source))
          rows.push(`<div class="memory-row"><span>${esc(k)}</span><span>${esc(valueText(v))}</span></div>`);
      } else if(Array.isArray(obj.items)) {
        obj.items.forEach((v,j)=>rows.push(`<div class="memory-row"><span>${j}</span><span>${esc(valueText(v))}</span></div>`));
      }
      d.innerHTML=`<div class="memory-head"><span>${esc(obj.type||"object")}</span><span class="memory-id">${esc(id)}</span></div>${rows.join("")||'<div class="memory-row"><span>empty</span><span>—</span></div>'}`;
      el.memoryLayer.appendChild(d);
    });
  }

  function renderAction(e) {
    if(!e) {
      el.eventType.textContent="READY"; el.eventTitle.textContent="Run code to begin";
      el.eventDetail.textContent="The execution canvas will grow with the actual execution.";
      el.status.textContent="READY"; return;
    }
    const type=String(e.event||"LINE_EXECUTED"), fn=String(e.function||"<module>"), line=e.line||"—";
    el.eventType.textContent=type; el.status.textContent=`STEP ${state.step+1}`;
    let title=`${fn} · line ${line}`, detail="";
    if(type==="FUNCTION_ENTER") detail=`Called ${fn}(${formatArgs(e)})`;
    else if(type==="FUNCTION_EXIT") detail=`${fn} returned ${valueText(e.returnValue??e.returnedValue??e.value)}`;
    else if(type==="CONDITION_EVALUATED") detail=`${e.condition || "Condition"} → ${e.result ?? e.value ?? "evaluated"}`;
    else if(type==="MEMORY_WRITE") detail=`Memory write: ${e.key!==undefined?valueText(e.key):""} ${e.value!==undefined?"→ "+valueText(e.value):""}`;
    else if(type==="CACHE_HIT") detail="Cached value found.";
    else if(type==="CACHE_MISS") detail="Cached value not found.";
    else detail=`Executed line ${line}.`;
    el.eventTitle.textContent=title; el.eventDetail.textContent=detail;
  }

  function formatArgs(e) {
    const a=makeArgs(e);
    return Object.entries(a).map(([k,v])=>`${k}=${v}`).join(", ") || "no arguments";
  }

  function updateSource(e) {
    const line=Number(e?.line||0);
    el.currentLine.textContent=line||"—";
    const lines=el.code.value.split("\n");
    el.gutter.innerHTML=lines.map((_,i)=>`<div class="${i+1===line?"active":""}">${i+1}</div>`).join("");
    if(!line){el.lineHighlight.style.display="none";return;}
    el.lineHighlight.style.display="block";
    el.lineHighlight.style.top=`${(line-1)*20}px`;
    const desired=(line-1)*20;
    if(desired<el.code.scrollTop || desired>el.code.scrollTop+el.code.clientHeight-30)
      el.code.scrollTop=Math.max(0,desired-el.code.clientHeight/2);
    el.gutter.scrollTop=el.code.scrollTop;
  }

  function renderOverlays(e) {
    const stack=stackOf(e);
    el.stackContent.innerHTML=stack.map(s=>`<div class="stack-item ${s.id===activeFrameId(e)?"active":""}">${esc(s.fn)} <span>${esc(s.id)}</span></div>`).join("")||"<small>No active stack</small>";
    const objects=e?.objects||{};
    el.memoryContent.innerHTML=Object.entries(objects).map(([id,obj])=>{
      const src=obj.fields??obj.entries;
      const rows=src&&typeof src==="object"?Object.entries(src).map(([k,v])=>`<div class="memory-row"><span>${esc(k)}</span><span>${esc(valueText(v))}</span></div>`).join(""):"";
      return `<div class="memory-item"><b>${esc(obj.type||"object")} · ${esc(id)}</b>${rows}</div>`;
    }).join("")||"<small>No heap objects at this step.</small>";
  }

  function render() {
    const e=state.events[state.step]||null;
    state.frames=reconstructFrames(state.step);
    buildChildren();
    layout();
    renderFrames();
    renderEdges();
    renderMemory(e);
    renderAction(e);
    updateSource(e);
    renderOverlays(e);

    el.empty.classList.toggle("hidden",state.frames.size>0);
    el.stepText.textContent=`Step ${state.events.length?state.step+1:0} / ${state.events.length}`;
    el.timelineEvent.textContent=e?`${e.function||"<module>"} · ${e.event||"LINE_EXECUTED"}`:"";
    el.range.max=Math.max(0,state.events.length-1); el.range.value=state.step;
    el.output.textContent=`Output: ${state.output||"—"}`;
    el.prev.disabled=state.step<=0; el.next.disabled=state.step>=state.events.length-1;
    el.play.textContent=state.playing?"⏸ Pause":"▶ Play";

    if(state.follow && activeFrameId(e)) focusFrame(activeFrameId(e),false);
    applyTransform();
  }

  function applyTransform() {
    el.world.style.transform=`translate(${state.panX}px,${state.panY}px) scale(${state.zoom})`;
    const z=Math.round(state.zoom*100); el.zoomLabel.textContent=`${z}%`; el.hudZoom.textContent=`${z}%`;
  }

  function focusFrame(id=activeFrameId(state.events[state.step]), instant=true) {
    const p=state.positions.get(id); if(!p)return;
    const w=240,h=155;
    const tx=el.viewport.clientWidth/2-(p.x+w/2)*state.zoom;
    const ty=el.viewport.clientHeight/2-(p.y+h/2)*state.zoom;
    if(instant){state.panX=tx;state.panY=ty}
    else {state.panX += (tx-state.panX)*.75;state.panY += (ty-state.panY)*.75}
    applyTransform();
  }

  function fit() {
    if(!state.positions.size)return;
    const ps=[...state.positions.values()];
    const minX=Math.min(...ps.map(p=>p.x)),maxX=Math.max(...ps.map(p=>p.x+240));
    const minY=Math.min(...ps.map(p=>p.y)),maxY=Math.max(...ps.map(p=>p.y+155));
    const vw=el.viewport.clientWidth-50,vh=el.viewport.clientHeight-50;
    state.zoom=Math.max(.35,Math.min(1.25,vw/(maxX-minX||1),vh/(maxY-minY||1)));
    state.panX=(el.viewport.clientWidth-(maxX-minX)*state.zoom)/2-minX*state.zoom;
    state.panY=(el.viewport.clientHeight-(maxY-minY)*state.zoom)/2-minY*state.zoom;
    applyTransform();
  }

  function zoomAt(factor,cx,cy) {
    const old=state.zoom,next=Math.max(.3,Math.min(2.5,old*factor));
    if(next===old)return;
    const r=el.viewport.getBoundingClientRect(),x=cx-r.left,y=cy-r.top;
    state.panX=x-(x-state.panX)*next/old; state.panY=y-(y-state.panY)*next/old; state.zoom=next; applyTransform();
  }

  function setStep(n) {
    if(!state.events.length)return;
    state.step=Math.max(0,Math.min(state.events.length-1,n));
    render();
  }

  function play() {
    if(state.playing){state.playing=false;clearInterval(state.timer);state.timer=null;render();return;}
    if(state.step>=state.events.length-1)state.step=0;
    state.playing=true;render();
    state.timer=setInterval(()=>{
      if(state.step>=state.events.length-1){play();return}
      setStep(state.step+1);
    },650);
  }

  function reset() {
    state.playing=false;clearInterval(state.timer);state.timer=null;state.step=0;
    state.zoom=1;state.panX=0;state.panY=0;render();fit();
  }

  async function run() {
    state.playing=false;clearInterval(state.timer);state.timer=null;
    el.run.disabled=true;el.run.textContent="Running…";el.error.textContent="";
    try {
      const r=await fetch("/api/execute",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({language:el.language.value,code:el.code.value})});
      const data=await r.json();
      if(!r.ok) throw new Error(data?.error||"Execution failed");
      state.events=Array.isArray(data)?data:(data.events||[]);
      state.output=data.output||state.events.find(e=>e?.output)?.output||"";
      if(!state.events.length)throw new Error("No execution events returned.");
      state.step=0;state.zoom=1;state.panX=0;state.panY=0;render();fit();
    } catch(err) {el.error.textContent=err.message||String(err)}
    finally {el.run.disabled=false;el.run.textContent="▶ Run Code"}
  }

  // Source editor.
  el.code.addEventListener("scroll",()=>el.gutter.scrollTop=el.code.scrollTop);
  el.code.addEventListener("input",()=>updateSource(state.events[state.step]));
  el.code.addEventListener("keydown",e=>{
    if(e.key==="Tab"){e.preventDefault();const s=el.code.selectionStart;el.code.setRangeText("    ",s,el.code.selectionEnd,"end");}
  });

  // Canvas navigation: normal wheel = pan; Ctrl/Cmd+wheel = zoom.
  el.viewport.addEventListener("wheel",e=>{
    e.preventDefault();
    if(e.ctrlKey||e.metaKey){zoomAt(e.deltaY<0?1.1:.9,e.clientX,e.clientY);return}
    state.panX-=e.deltaX;state.panY-=e.deltaY;applyTransform();
  },{passive:false});

  el.viewport.addEventListener("pointerdown",e=>{
    if(e.button===1 || (e.button===0&&state.space)){
      state.panning=true;state.panStart={x:e.clientX,y:e.clientY,px:state.panX,py:state.panY};
      el.viewport.setPointerCapture(e.pointerId);
    }
  });
  el.viewport.addEventListener("pointermove",e=>{
    if(!state.panning)return;
    state.panX=state.panStart.px+(e.clientX-state.panStart.x);
    state.panY=state.panStart.py+(e.clientY-state.panStart.y);applyTransform();
  });
  el.viewport.addEventListener("pointerup",e=>{state.panning=false;try{el.viewport.releasePointerCapture(e.pointerId)}catch{}});
  window.addEventListener("keydown",e=>{
    if(e.target===el.code)return;
    if(e.code==="Space"){state.space=true;e.preventDefault()}
    if(e.key==="f"||e.key==="F"){e.preventDefault();state.follow=true;el.follow.checked=true;focusFrame()}
    if(e.key==="0"){e.preventDefault();fit()}
    if(e.key==="+"||e.key==="="){e.preventDefault();zoomAt(1.15,el.viewport.clientWidth/2,el.viewport.clientHeight/2)}
    if(e.key==="-"){e.preventDefault();zoomAt(.87,el.viewport.clientWidth/2,el.viewport.clientHeight/2)}
  });
  window.addEventListener("keyup",e=>{if(e.code==="Space")state.space=false});

  // Controls.
  el.run.addEventListener("click",run);
  el.prev.addEventListener("click",()=>setStep(state.step-1));
  el.next.addEventListener("click",()=>setStep(state.step+1));
  el.play.addEventListener("click",play);
  el.reset.addEventListener("click",reset);
  el.range.addEventListener("input",e=>setStep(Number(e.target.value)));
  el.follow.addEventListener("change",()=>state.follow=el.follow.checked);
  el.fit.addEventListener("click",fit);el.hudFit.addEventListener("click",fit);
  el.focus.addEventListener("click",()=>focusFrame());
  el.zoomIn.addEventListener("click",()=>zoomAt(1.15,el.viewport.clientWidth/2,el.viewport.clientHeight/2));
  el.zoomOut.addEventListener("click",()=>zoomAt(.87,el.viewport.clientWidth/2,el.viewport.clientHeight/2));
  el.hudZoomIn.addEventListener("click",()=>zoomAt(1.15,el.viewport.clientWidth/2,el.viewport.clientHeight/2));
  el.hudZoomOut.addEventListener("click",()=>zoomAt(.87,el.viewport.clientWidth/2,el.viewport.clientHeight/2));

  el.stackBtn.addEventListener("click",()=>el.stackOverlay.classList.toggle("hidden"));
  el.memoryBtn.addEventListener("click",()=>el.memoryOverlay.classList.toggle("hidden"));
  el.max.addEventListener("click",()=>{state.max=!state.max;el.visual.classList.toggle("max",state.max);setTimeout(()=>{if(state.max)focusFrame();else fit()},20)});

  window.addEventListener("resize",()=>{if(state.max)focusFrame()});
  updateSource(null);
})();
