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
    events: [],
    semanticSteps: [],
    aiExplanations: [],
    askAnswer: "",
    asking: false,
    step: 0,
    output: "",
    playing: false,
    timer: null,
    frames: new Map(),
    positions: new Map(),
    zoom: 1,
    panX: 0,
    panY: 0,
    follow: true,
    panning: false,
    space: false,
    max: false,
    viewMode: "execution"
  };

  const el = {
    code: $("codeInput"), gutter: $("gutter"), lineHighlight: $("lineHighlight"), currentLine: $("currentLine"),
    run: $("runBtn"), language: $("language"), viewport: $("viewport"), world: $("world"),
    edges: $("edges"), edgeLayer: $("edgeLayer"), nodes: $("nodeLayer"), memoryLayer: $("memoryLayer"),
    empty: $("empty"), eventType: $("eventType"), eventTitle: $("eventTitle"), eventDetail: $("eventDetail"),
    status: $("statusBadge"), stepText: $("stepText"), timelineEvent: $("timelineEvent"), range: $("range"),
    prev: $("prevBtn"), next: $("nextBtn"), play: $("playBtn"), reset: $("resetBtn"), output: $("output"), error: $("error"),
    zoomLabel: $("zoomLabel"), hudZoom: $("hudZoom"), follow: $("followToggle"), visual: $("visualPanel"),
    fit: $("fitBtn"), focus: $("focusBtn"), zoomIn: $("zoomIn"), zoomOut: $("zoomOut"),
    hudFit: $("hudFit"), hudZoomIn: $("hudZoomIn"), hudZoomOut: $("hudZoomOut"),
    max: $("maxBtn"), stackBtn: $("stackBtn"), memoryBtn: $("memoryBtn"),
    stackOverlay: $("stackOverlay"), memoryOverlay: $("memoryOverlay"),
    stackContent: $("stackContent"), memoryContent: $("memoryContent"),
    executionView: $("executionView"), memoryView: $("memoryView"), memoryGraph: $("memoryGraph"),
    aiExplanation: $("aiText"), aiStep: $("aiStep"), aiText: $("aiText"),
    aiEventType: $("aiEventType"), aiEventTitle: $("aiEventTitle"), aiEventDetail: $("aiEventDetail"),
    aiStepCount: $("aiStepCount"), aiLine: $("aiLine"), aiVariables: $("aiVariables"),
    askInput: $("askInput"), askBtn: $("askBtn"), askAnswer: $("askAnswer"), askStatus: $("askStatus"),
    viewButtons: [...document.querySelectorAll("[data-view]")]
  };

  el.code.value = DEFAULT_CODE;

  const esc = v => String(v ?? "").replace(/[&<>\"']/g, c => ({
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
      id: String(x?.frameId ?? `stack_${i}`),
      fn: String(x?.function ?? "<module>")
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
    for (const [k, v] of Object.entries(vars)) {
      if (k.startsWith("__") || k === "self") continue;
      out[k] = v;
    }
    return out;
  }

  function sourceLine(n) {
    const lines = el.code.value.split("\n");
    return lines[Math.max(0, Number(n || 1) - 1)] || "";
  }

  function formatArgs(e) {
    const a = e?.arguments && typeof e.arguments === "object" ? e.arguments : makeArgs(e);
    return Object.entries(a).map(([k, v]) => `${k}=${valueText(v)}`).join(", ") || "no arguments";
  }

  function reconstructFrames(step) {
    const frames = new Map();

    const ensure = (id, e, firstStep) => {
      if (!id) return null;
      if (!frames.has(id)) {
        frames.set(id, {
          id,
          fn: String(e?.function ?? "<module>"),
          parentId: null,
          firstStep,
          lastStep: firstStep,
          enterStep: null,
          exitStep: null,
          line: Number(e?.line || 0),
          args: {},
          vars: {},
          status: "WAITING",
          returnValue: "",
          lastEvent: "",
          children: []
        });
      }
      return frames.get(id);
    };

    for (let i = 0; i <= step && i < state.events.length; i++) {
      const e = state.events[i];
      const stack = stackOf(e);

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

      for (let j = 1; j < stack.length; j++) {
        const child = frames.get(stack[j].id);
        const parent = frames.get(stack[j - 1].id);
        if (child && parent) child.parentId = parent.id;
      }
    }

    for (let i = 0; i <= step && i < state.events.length; i++) {
      const e = state.events[i];
      const id = activeFrameId(e);
      const f = frames.get(id);
      if (!f) continue;
      if (e.event === "FUNCTION_ENTER") f.enterStep = f.enterStep ?? i;
      if (e.event === "FUNCTION_EXIT") {
        f.exitStep = i;
        const rv = e.returnValue ?? e.returnedValue ?? e.return_value ?? e.value;
        if (rv !== undefined) f.returnValue = valueText(rv);
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
      f.children.sort((a, b) => state.frames.get(a).firstStep - state.frames.get(b).firstStep);
    }
  }

  function branchLabel(parent, child, index) {
    const line = sourceLine(parent.line).trim();
    if (parent.children.length < 2) return "CALL";
    if (parent.fn === child.fn) return /for\s|while\s|for\(|while\(/i.test(line) ? "ITERATION" : "RECURSION";
    if (/left\s*=/.test(line)) return index === 0 ? "LEFT" : "RIGHT";
    if (/right\s*=/.test(line)) return index === 0 ? "RIGHT" : "LEFT";
    if (/[+*/-]/.test(line)) return index === 0 ? "LEFT" : "RIGHT";
    return `BRANCH ${index + 1}`;
  }

  function formatFrameSignature(f, compact = false) {
    const args = Object.entries(f.args || {}).filter(([k]) => !k.startsWith("__") && k !== "self");
    if (!args.length) return `${f.fn}()`;

    const pieces = args.slice(0, 3).map(([k, v]) => `${k}=${valueText(v)}`);
    const rendered = pieces.join(", ");
    const signature = `${f.fn}(${rendered})`;
    if (!compact || signature.length <= 28) return signature;
    return `${f.fn}(${pieces.slice(0, 2).join(", ")}${args.length > 2 ? ", …" : ""})`;
  }

  function branchHintForFrame(f, parentId = null) {
    const parent = parentId && state.frames.get(parentId);
    if (!parent) return "CALL";
    const line = sourceLine(parent.line).trim();
    if (!line) return "CALL";
    if (parent.fn === f.fn) return /for\s|while\s|for\(|while\(/i.test(line) ? "ITERATION" : "RECURSION";
    if (/left\s*=/.test(line)) return "LEFT BRANCH";
    if (/right\s*=/.test(line)) return "RIGHT BRANCH";
    if (/if\s+.*<=|if\s+.*<|if\s+.*>|if\s+.*>=|if\s+.*!=|if\s+.*==/i.test(line)) return "CONDITION";
    if (/[+*/-]/.test(line)) return "EXPRESSION";
    return "CALL";
  }

  function sourceBranchLabel(stmt = "") {
    const cleaned = stmt.trim();
    if (!cleaned) return "CALL";
    if (/left\s*=/.test(cleaned)) return "LEFT BRANCH";
    if (/right\s*=/.test(cleaned)) return "RIGHT BRANCH";
    if (/if\s+.*<=|if\s+.*<|if\s+.*>|if\s+.*>=|if\s+.*!=|if\s+.*==/i.test(cleaned)) return "CONDITION";
    if (/return\s+.*[+\-*/]/.test(cleaned)) return "EXPRESSION";
    return "CALL";
  }

  function layout() {
    state.positions.clear();
    const roots = [...state.frames.values()].filter(f => !f.parentId || !state.frames.has(f.parentId))
      .sort((a, b) => a.firstStep - b.firstStep);

    const NODE_W = 240;
    const XGAP = 55;
    const YGAP = 70;
    let cursor = 0;

    function walk(id, depth) {
      const f = state.frames.get(id);
      const children = f.children || [];
      if (!children.length) {
        const x = cursor * (NODE_W + XGAP);
        cursor++;
        state.positions.set(id, { x, y: depth * (155 + YGAP) });
        return x;
      }
      const xs = children.map(c => walk(c, depth + 1));
      const x = (xs[0] + xs[xs.length - 1]) / 2;
      state.positions.set(id, { x, y: depth * (155 + YGAP) });
      return x;
    }

    roots.forEach(r => walk(r.id, 0));
  }

  function frameHtml(f) {
    const args = Object.entries(f.args || {}).filter(([k]) => !k.startsWith("__") && k !== "self");
    const signature = formatFrameSignature(f, true);
    const locals = Object.entries(f.vars || {}).filter(([k]) => !k.startsWith("__") && k !== "self");
    const stmt = sourceLine(f.line).trim();
    const branch = branchHintForFrame(f, f.parentId) || sourceBranchLabel(stmt);
    const scope = locals.slice(0, 4).map(([k, v]) => `<span>${esc(k)}=${esc(valueText(v))}</span>`).join("");
    const active = f.status === "ACTIVE";
    let note = active ? `Executing: ${stmt || `line ${f.line}`}` : f.status === "RETURNED" ? "Invocation completed" : "Waiting for child";
    if (f.returnValue) note += `<div class="return">↩ returned ${esc(f.returnValue)}</div>`;

    return `<div class="frame ${f.status.toLowerCase()} ${active ? "active" : ""}" data-frame="${esc(f.id)}">
      <div class="frame-head"><span class="frame-name">${esc(signature)}</span><span class="state">${f.status}</span></div>
      <div class="execution-summary">
        <div class="statement-line">${esc(stmt || `line ${f.line}`)}</div>
        <div class="branch-pill ${branch.toLowerCase().replace(/\s+/g, "-")}">${esc(branch)}</div>
      </div>
      <div class="locals-strip">${scope || '<span>no locals</span>'}</div>
      <div class="meta"><span>frame ${esc(f.id)}</span><span>line ${f.line}</span></div>
      <div class="note">${note}</div>
    </div>`;
  }

  function renderFrames() {
    el.nodes.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const f of state.frames.values()) {
      const p = state.positions.get(f.id); if (!p) continue;
      const d = document.createElement("div");
      d.className = "frame-host";
      d.style.cssText = `position:absolute;left:${p.x}px;top:${p.y}px;width:240px;height:155px`;
      d.innerHTML = frameHtml(f);
      d.querySelector(".frame").addEventListener("dblclick", () => focusFrame(f.id));
      frag.appendChild(d);
    }
    el.nodes.appendChild(frag);
  }

  function renderEdges() {
    const pts = [...state.positions.values()];
    const maxX = Math.max(1000, ...pts.map(p => p.x + 240));
    const maxY = Math.max(700, ...pts.map(p => p.y + 170));
    el.edges.setAttribute("width", maxX);
    el.edges.setAttribute("height", maxY);
    el.edgeLayer.innerHTML = "";
    const active = activeFrameId(state.events[state.step]);

    for (const parent of state.frames.values()) {
      const a = state.positions.get(parent.id); if (!a) continue;
      parent.children.forEach((cid, index) => {
        const child = state.frames.get(cid);
        const b = state.positions.get(cid);
        if (!child || !b) return;
        const x1 = a.x + 120;
        const y1 = a.y + 155;
        const x2 = b.x + 120;
        const y2 = b.y;
        const mid = (y1 + y2) / 2;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`);
        if (parent.id === active || child.id === active) path.classList.add("active");
        el.edgeLayer.appendChild(path);
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", (x1 + x2) / 2);
        t.setAttribute("y", mid - 5);
        t.setAttribute("text-anchor", "middle");
        t.textContent = branchLabel(parent, child, index);
        el.edgeLayer.appendChild(t);
      });
    }
  }

  function renderMemory(e) {
    el.memoryLayer.innerHTML = "";
    const objects = e?.objects || {};
    const ids = Object.keys(objects);
    if (!ids.length) return;

    const ys = Math.max(520, ...[...state.positions.values()].map(p => p.y + 180));
    ids.forEach((id, i) => {
      const obj = objects[id] || {};
      const d = document.createElement("div");
      d.className = "memory-card";
      d.style.left = `${i * 240}px`;
      d.style.top = `${ys}px`;
      const rows = [];
      const source = obj.fields ?? obj.entries;
      if (source && typeof source === "object") {
        for (const [k, v] of Object.entries(source)) rows.push(`<div class="memory-row"><span>${esc(k)}</span><span>${esc(valueText(v))}</span></div>`);
      } else if (Array.isArray(obj.items)) {
        obj.items.forEach((v, j) => rows.push(`<div class="memory-row"><span>${j}</span><span>${esc(valueText(v))}</span></div>`));
      }
      d.innerHTML = `<div class="memory-head"><span>${esc(obj.type || "object")}</span><span class="memory-id">${esc(id)}</span></div>${rows.join("") || '<div class="memory-row"><span>empty</span><span>—</span></div>'}`;
      el.memoryLayer.appendChild(d);
    });
  }

  function renderAction(e) {
    const total = state.events.length;
    const stepNo = total ? state.step + 1 : 0;

    el.aiStepCount.textContent = `Step ${stepNo} / ${total}`;

    if (!e) {
      el.aiEventType.textContent = "READY";
      el.aiEventTitle.textContent = "Run code to begin";
      el.aiEventDetail.textContent = "The current execution step will appear here.";
      el.aiLine.textContent = "—";
      el.aiVariables.innerHTML = '<span class="ai-empty-chip">—</span>';
      return;
    }

    const type = String(e.event || "LINE_EXECUTED");
    const fn = String(e.function || "<module>");
    const line = Number(e.line || 0);
    const statement = sourceLine(line).trim();

    el.aiEventType.textContent = friendlyEventType(type);
    el.aiEventTitle.textContent = `${fn} · Line ${line || "?"}`;
    el.aiLine.textContent = String(line || "—");

    let detail = "";
    if (type === "FUNCTION_ENTER") {
      detail = `Called ${fn}(${formatArgs(e)})`;
    } else if (type === "FUNCTION_EXIT") {
      detail = `${fn} returned ${valueText(e.returnValue ?? e.returnedValue ?? e.value)}`;
    } else if (type === "CONDITION_EVALUATED") {
      const condition = cleanCondition(e, statement);
      const result = conditionResult(e);
      detail = `Checking condition: ${condition}  →  ${result}`;
    } else if (type === "MEMORY_WRITE") {
      detail = `Memory updated${e.key !== undefined ? `: ${valueText(e.key)}` : ""}${e.value !== undefined ? ` → ${valueText(e.value)}` : ""}`;
    } else if (type === "CACHE_HIT") {
      detail = "A previously computed value was reused.";
    } else if (type === "CACHE_MISS") {
      detail = "No cached value was available, so execution continues.";
    } else {
      detail = statement ? `Executing: ${statement}` : `Executed line ${line}.`;
    }

    el.aiEventDetail.textContent = detail;

    const vars = Object.entries(e.variables || {})
      .filter(([k]) => !k.startsWith("__") && k !== "self");

    el.aiVariables.innerHTML = vars.length
      ? vars.slice(0, 8).map(([k, v]) =>
          `<span class="ai-var-chip"><b>${esc(k)}</b><span>${esc(valueText(v))}</span></span>`
        ).join("")
      : '<span class="ai-empty-chip">No local variables</span>';
  }

  function friendlyEventType(type) {
    const labels = {
      "LINE_EXECUTED": "LINE EXECUTED",
      "CONDITION_EVALUATED": "CONDITION CHECK",
      "FUNCTION_ENTER": "FUNCTION CALL",
      "FUNCTION_EXIT": "FUNCTION RETURN",
      "ASSIGNMENT": "ASSIGNMENT",
      "EXPRESSION_RESULT": "EXPRESSION",
      "MEMORY_WRITE": "MEMORY UPDATE",
      "OUTPUT": "OUTPUT"
    };
    return labels[type] || type.replaceAll("_", " ");
  }

  function conditionResult(e) {
    const value = e?.result ?? e?.value ?? e?.conditionResult ?? e?.outcome;
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    const text = String(value ?? "").trim().toLowerCase();
    if (text === "true") return "TRUE";
    if (text === "false") return "FALSE";
    return valueText(value || "evaluated");
  }

  function cleanCondition(e, statement = "") {
    // Prefer the actual source line because the raw tracer may contain
    // an internal helper such as _expr_compare(...AST...).
    const source = statement.trim();
    if (/^if\s+/i.test(source)) {
      return source.replace(/^if\s+/i, "").replace(/:\s*$/, "").trim();
    }

    const raw = String(e?.condition || e?.expression || e?.expr || "").trim();
    if (raw && !raw.includes("_expr_") && raw.length < 120) return raw;

    return "Condition";
  }

  function currentSemanticStepInfo() {
    if (!state.semanticSteps.length || !state.events.length) return null;

    const currentEvent = state.events[state.step];
    const rawStep = Number(currentEvent?.step ?? state.step);
    let semanticIndex = -1;

    for (let i = 0; i < state.semanticSteps.length; i++) {
      const semanticEventStep = Number(
        state.semanticSteps[i]?.event?.step ??
        state.semanticSteps[i]?.event?.eventStep ??
        -1
      );
      if (semanticEventStep <= rawStep) semanticIndex = i;
      else break;
    }

    if (semanticIndex < 0) {
      semanticIndex = Math.min(state.step, state.semanticSteps.length - 1);
    }

    return {
      index: semanticIndex,
      step: state.semanticSteps[semanticIndex]
    };
  }

  function renderAIExplanation() {
    const info = currentSemanticStepInfo();

    if (!info) {
      el.aiStep.textContent = "Waiting for execution";
      el.aiText.textContent = "Run your code to generate a student-friendly explanation.";
      return;
    }

    const semanticStep = info.step;
    const explanation = state.aiExplanations.find(
      item => Number(item.step) === Number(semanticStep.step)
    );

    el.aiStep.textContent = `Semantic Step ${semanticStep.step} · Line ${semanticStep.line}`;

    if (explanation?.explanation) {
      el.aiText.textContent = explanation.explanation;
    } else {
      el.aiText.textContent = "AI explanation is not available for this step yet.";
    }
  }

  function clearAskAnswer() {
    state.askAnswer = "";
    state.asking = false;
    el.askAnswer.textContent = "";
    el.askAnswer.classList.add("hidden");
    el.askStatus.textContent = "Uses the verified execution context.";
    el.askBtn.disabled = false;
    el.askBtn.textContent = "✦ Ask GenAI";
  }

  async function askGenAI() {
    const question = el.askInput.value.trim();
    if (!question) {
      el.askStatus.textContent = "Type a question first.";
      el.askInput.focus();
      return;
    }

    if (!state.events.length) {
      el.askStatus.textContent = "Run the program first.";
      return;
    }

    const info = currentSemanticStepInfo();
    const currentEvent = state.events[state.step];

    state.asking = true;
    el.askBtn.disabled = true;
    el.askBtn.textContent = "Asking…";
    el.askStatus.textContent = "Generating an answer from the verified trace.";
    el.askAnswer.classList.remove("hidden");
    el.askAnswer.textContent = "Thinking about the current execution step…";

    try {
      const trace = {
        currentEvent,
        semanticStep: info?.step || null,
        previousSemanticSteps: info
          ? state.semanticSteps.slice(0, info.index + 1)
          : [],
        output: state.output
      };

      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: el.code.value,
          question,
          trace
        })
      });

      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Could not get an answer.");

      state.askAnswer = String(data.answer || "No answer was returned.");
      el.askAnswer.textContent = state.askAnswer;
      el.askStatus.textContent = "Answer based on the verified execution context.";
    } catch (err) {
      el.askAnswer.textContent = err.message || String(err);
      el.askStatus.textContent = "Could not contact GenAI.";
    } finally {
      state.asking = false;
      el.askBtn.disabled = false;
      el.askBtn.textContent = "✦ Ask GenAI";
    }
  }

  function updateSource(e) {
    const line = Number(e?.line || 0);
    el.currentLine.textContent = line || "—";
    const lines = el.code.value.split("\n");
    el.gutter.innerHTML = lines.map((_, i) => `<div class="${i + 1 === line ? "active" : ""}">${i + 1}</div>`).join("");
    if (!line) {
      el.lineHighlight.style.display = "none";
      return;
    }
    // The textarea has 11px top padding, so the highlight must use the same
    // baseline. This keeps the highlighted row aligned with the actual text.
    const lineHeight = 20;
    const topPadding = 11;
    const desired = (line - 1) * lineHeight;
    el.lineHighlight.style.display = "block";
    el.lineHighlight.style.top = `${topPadding + desired - el.code.scrollTop}px`;

    if (desired < el.code.scrollTop || desired > el.code.scrollTop + el.code.clientHeight - 30) {
      el.code.scrollTop = Math.max(0, desired - el.code.clientHeight / 2);
    }
    el.gutter.scrollTop = el.code.scrollTop;
    el.lineHighlight.style.top = `${topPadding + desired - el.code.scrollTop}px`;
  }

  function renderOverlays(e) {
    const stack = stackOf(e);
    el.stackContent.innerHTML = stack.map(s => `<div class="stack-item ${s.id === activeFrameId(e) ? "active" : ""}">${esc(s.fn)} <span>${esc(s.id)}</span></div>`).join("") || "<small>No active stack</small>";

    const objects = e?.objects || {};
    el.memoryContent.innerHTML = Object.entries(objects).map(([id, obj]) => {
      const src = obj.fields ?? obj.entries;
      const rows = src && typeof src === "object" ? Object.entries(src).map(([k, v]) => `<div class="memory-row"><span>${esc(k)}</span><span>${esc(valueText(v))}</span></div>`).join("") : "";
      return `<div class="memory-item"><b>${esc(obj.type || "object")} · ${esc(id)}</b>${rows}</div>`;
    }).join("") || "<small>No heap objects at this step.</small>";
  }

  function getObjectFields(obj) {
    if (!obj || typeof obj !== "object") return {};
    const source = obj.fields ?? obj.entries;
    if (source && typeof source === "object" && !Array.isArray(source)) return source;
    return {};
  }

  function getReferenceTarget(value) {
    if (!value || typeof value !== "object") return null;
    return value.objectId ? String(value.objectId) : null;
  }

  function renderMemoryGraph(e) {
    const graph = el.memoryGraph;
    graph.innerHTML = "";
    const objects = e?.objects || {};
    const ids = Object.keys(objects);

    if (!ids.length) {
      graph.innerHTML = '<div class="empty"><div class="empty-icon">◎</div><b>No memory graph</b><span>Objects will appear when code creates them.</span></div>';
      return;
    }

    // Build a clean reference graph from the tracer's objectId references.
    const nodes = new Map();
    const edges = [];
    const incoming = new Map();

    ids.forEach(id => {
      const obj = objects[id] || {};
      const fields = getObjectFields(obj);
      nodes.set(id, { id, type: obj.type || "object", fields });

      Object.entries(fields).forEach(([key, value]) => {
        const target = getReferenceTarget(value);
        if (!target || !objects[target]) return;
        edges.push({ from: id, to: target, label: key });
        incoming.set(target, (incoming.get(target) || 0) + 1);
      });
    });

    // Prefer a horizontal linked-list layout for next -> next -> next chains.
    const nextEdges = edges.filter(e => e.label === "next");
    const nextTargets = new Set(nextEdges.map(e => e.to));
    const linkedRoots = ids.filter(id => !nextTargets.has(id) && nextEdges.some(e => e.from === id));

    const pos = new Map();
    const placed = new Set();
    const NODE_W = 190;
    const NODE_H = 126;
    const X_GAP = 85;
    const Y_GAP = 75;

    function placeChain(root, lane) {
      let current = root;
      let index = 0;
      const localSeen = new Set();
      while (current && !localSeen.has(current) && nodes.has(current)) {
        localSeen.add(current);
        if (!pos.has(current)) {
          pos.set(current, { x: 30 + index * (NODE_W + X_GAP), y: 30 + lane * (NODE_H + Y_GAP) });
          placed.add(current);
        }
        const next = nextEdges.find(edge => edge.from === current);
        current = next ? next.to : null;
        index++;
      }
    }

    linkedRoots.forEach((id, i) => placeChain(id, i));

    // Place remaining object graphs using a compact breadth-first layout.
    const remaining = ids.filter(id => !pos.has(id));
    let lane = Math.max(0, linkedRoots.length);
    remaining.forEach(root => {
      if (pos.has(root)) return;
      const queue = [{ id: root, depth: 0, row: lane }];
      const localSeen = new Set();
      while (queue.length) {
        const item = queue.shift();
        if (localSeen.has(item.id) || !nodes.has(item.id)) continue;
        localSeen.add(item.id);
        if (!pos.has(item.id)) {
          pos.set(item.id, {
            x: 30 + item.depth * (NODE_W + X_GAP),
            y: 30 + item.row * (NODE_H + Y_GAP)
          });
        }
        const outgoing = edges.filter(edge => edge.from === item.id);
        outgoing.forEach((edge, idx) => {
          if (!localSeen.has(edge.to) && !pos.has(edge.to)) {
            queue.push({ id: edge.to, depth: item.depth + 1, row: item.row + idx });
          }
        });
      }
      lane += Math.max(1, localSeen.size);
    });

    ids.forEach((id, i) => {
      if (!pos.has(id)) pos.set(id, { x: 30 + i * (NODE_W + X_GAP), y: 30 + lane * (NODE_H + Y_GAP) });
    });

    const svgNS = "http://www.w3.org/2000/svg";
    const width = Math.max(900, ...Array.from(pos.values()).map(p => p.x + NODE_W + 80));
    const height = Math.max(500, ...Array.from(pos.values()).map(p => p.y + NODE_H + 80));
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);

    const defs = document.createElementNS(svgNS, "defs");
    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", "memoryArrow");
    marker.setAttribute("viewBox", "0 0 12 12");
    marker.setAttribute("refX", "10");
    marker.setAttribute("refY", "6");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("orient", "auto");
    const arrow = document.createElementNS(svgNS, "path");
    arrow.setAttribute("d", "M 0 0 L 12 6 L 0 12 z");
    arrow.setAttribute("fill", "#79b8ff");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // Draw connections using the actual node geometry so arrows touch the cards.
    edges.forEach(edge => {
      const a = pos.get(edge.from);
      const b = pos.get(edge.to);
      if (!a || !b) return;

      const sameRow = Math.abs(a.y - b.y) < 8;
      const forward = b.x >= a.x;
      const x1 = forward ? a.x + NODE_W : a.x;
      const y1 = a.y + NODE_H / 2;
      const x2 = forward ? b.x : b.x + NODE_W;
      const y2 = b.y + NODE_H / 2;
      const path = document.createElementNS(svgNS, "path");

      if (sameRow) {
        const bend = forward ? 42 : -42;
        path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      } else {
        const midX = (x1 + x2) / 2;
        path.setAttribute("d", `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);
      }
      path.setAttribute("stroke", "#79b8ff");
      path.setAttribute("stroke-width", edge.label === "next" ? "2.8" : "2.1");
      path.setAttribute("fill", "none");
      path.setAttribute("opacity", edge.label === "next" ? "0.95" : "0.72");
      path.setAttribute("marker-end", "url(#memoryArrow)");
      svg.appendChild(path);

      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", (x1 + x2) / 2);
      label.setAttribute("y", Math.min(y1, y2) - 10);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", edge.label === "next" ? "10" : "9");
      label.setAttribute("fill", "#d9ecff");
      label.textContent = edge.label;
      svg.appendChild(label);
    });

    graph.appendChild(svg);

    ids.forEach(id => {
      const node = nodes.get(id);
      const placement = pos.get(id) || { x: 30, y: 30 };
      const fields = Object.entries(node.fields || {}).slice(0, 6);
      const card = document.createElement("div");
      card.className = "memory-node";
      card.style.left = `${placement.x}px`;
      card.style.top = `${placement.y}px`;
      card.style.width = `${NODE_W}px`;
      card.style.minWidth = `${NODE_W}px`;
      card.style.maxWidth = `${NODE_W}px`;
      card.innerHTML = `
        <div class="memory-node-header">
          <span>${esc(node.type)}</span>
          <small>${esc(id)}</small>
        </div>
        <div class="memory-fields">
          ${fields.length ? fields.map(([key, value]) => `<div class="field"><span>${esc(key)}</span><strong>${esc(valueText(value))}</strong></div>`).join("") : '<div class="field"><span>empty</span><strong>—</strong></div>'}
        </div>
      `;
      graph.appendChild(card);
    });
  }

  function renderViewMode() {
    const mode = state.viewMode || "execution";
    const execHidden = mode === "memory";
    const memoryHidden = mode === "execution";
    el.executionView.classList.toggle("hidden", execHidden);
    el.memoryView.classList.toggle("hidden", memoryHidden);
    el.visual.classList.toggle("split-layout", mode === "split");
    el.viewButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.view === mode));
    if (mode === "memory") renderMemoryGraph(state.events[state.step] || null);
  }

 {
    const e = state.events[state.step] || null;
    state.frames = reconstructFrames(state.step);
    buildChildren();
    layout();
    renderFrames();
    renderEdges();
    renderMemory(e);
    renderAction(e);
    updateSource(e);
    renderOverlays(e);
    renderMemoryGraph(e);
    renderAIExplanation();

    el.empty.classList.toggle("hidden", state.frames.size > 0);
    el.stepText.textContent = `Step ${state.events.length ? state.step + 1 : 0} / ${state.events.length}`;
    el.timelineEvent.textContent = e ? `${e.function || "<module>"} · ${e.event || "LINE_EXECUTED"}` : "";
    el.range.max = Math.max(0, state.events.length - 1);
    el.range.value = state.step;
    el.output.textContent = `Output: ${state.output || "—"}`;
    el.prev.disabled = state.step <= 0;
    el.next.disabled = state.step >= state.events.length - 1;
    el.play.textContent = state.playing ? "⏸ Pause" : "▶ Play";

    if (state.follow && activeFrameId(e)) focusFrame(activeFrameId(e), false);
    renderViewMode();
    applyTransform();
  }

  function applyTransform() {
    el.world.style.transform = `translate(${state.panX}px,${state.panY}px) scale(${state.zoom})`;
    const z = Math.round(state.zoom * 100);
    el.zoomLabel.textContent = `${z}%`;
    el.hudZoom.textContent = `${z}%`;
  }

  function focusFrame(id = activeFrameId(state.events[state.step]), instant = true) {
    const p = state.positions.get(id); if (!p) return;
    const w = 240, h = 155;
    const tx = el.viewport.clientWidth / 2 - (p.x + w / 2) * state.zoom;
    const ty = el.viewport.clientHeight / 2 - (p.y + h / 2) * state.zoom;
    if (instant) {
      state.panX = tx;
      state.panY = ty;
    } else {
      state.panX += (tx - state.panX) * 0.75;
      state.panY += (ty - state.panY) * 0.75;
    }
    applyTransform();
  }

  function fit() {
    if (!state.positions.size) return;
    const ps = [...state.positions.values()];
    const minX = Math.min(...ps.map(p => p.x));
    const maxX = Math.max(...ps.map(p => p.x + 240));
    const minY = Math.min(...ps.map(p => p.y));
    const maxY = Math.max(...ps.map(p => p.y + 155));
    const vw = el.viewport.clientWidth - 50;
    const vh = el.viewport.clientHeight - 50;
    state.zoom = Math.max(.35, Math.min(1.25, vw / (maxX - minX || 1), vh / (maxY - minY || 1)));
    state.panX = (el.viewport.clientWidth - (maxX - minX) * state.zoom) / 2 - minX * state.zoom;
    state.panY = (el.viewport.clientHeight - (maxY - minY) * state.zoom) / 2 - minY * state.zoom;
    applyTransform();
  }

  function zoomAt(factor, cx, cy) {
    const old = state.zoom;
    const next = Math.max(.3, Math.min(2.5, old * factor));
    if (next === old) return;
    const r = el.viewport.getBoundingClientRect();
    const x = cx - r.left;
    const y = cy - r.top;
    state.panX = x - (x - state.panX) * next / old;
    state.panY = y - (y - state.panY) * next / old;
    state.zoom = next;
    applyTransform();
  }

  function setStep(n) {
    if (!state.events.length) return;
    const next = Math.max(0, Math.min(state.events.length - 1, n));
    if (next !== state.step) clearAskAnswer();
    state.step = next;
    render();
  }

  function play() {
    if (state.playing) {
      state.playing = false;
      clearInterval(state.timer);
      state.timer = null;
      render();
      return;
    }
    if (state.step >= state.events.length - 1) state.step = 0;
    state.playing = true;
    render();
    state.timer = setInterval(() => {
      if (state.step >= state.events.length - 1) {
        play();
        return;
      }
      setStep(state.step + 1);
    }, 650);
  }

  function reset() {
    state.playing = false;
    clearInterval(state.timer);
    state.timer = null;
    state.step = 0;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    clearAskAnswer();
    render();
    fit();
  }

  async function run() {
    state.playing = false;
    clearInterval(state.timer);
    state.timer = null;
    el.run.disabled = true;
    el.run.textContent = "Running…";
    el.error.textContent = "";
    state.semanticSteps = [];
    state.aiExplanations = [];
    clearAskAnswer();

    try {
      const r = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: el.language.value, code: el.code.value })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Execution failed");
      state.events = Array.isArray(data) ? data : (data.events || []);
      state.semanticSteps = Array.isArray(data.semanticSteps) ? data.semanticSteps : [];
      state.aiExplanations = Array.isArray(data.aiExplanations) ? data.aiExplanations : [];
      state.output = data.output || state.events.find(e => e?.output)?.output || "";
      if (!state.events.length) throw new Error("No execution events returned.");
      state.step = 0;
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      render();
      fit();
    } catch (err) {
      el.error.textContent = err.message || String(err);
    } finally {
      el.run.disabled = false;
      el.run.textContent = "▶ Run Code";
    }
  }

  // Source editor.
  el.code.addEventListener("scroll", () => {
    el.gutter.scrollTop = el.code.scrollTop;
    const line = Number(state.events[state.step]?.line || 0);
    if (line) {
      el.lineHighlight.style.top = `${11 + (line - 1) * 20 - el.code.scrollTop}px`;
    }
  });
  el.code.addEventListener("input", () => updateSource(state.events[state.step]));
  el.code.addEventListener("keydown", e => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = el.code.selectionStart;
      el.code.setRangeText("    ", s, el.code.selectionEnd, "end");
    }
  });

  // Canvas navigation.
  el.viewport.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX, e.clientY);
      return;
    }
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
    applyTransform();
  }, { passive: false });

  el.viewport.addEventListener("pointerdown", e => {
    if (e.button === 1 || (e.button === 0 && state.space)) {
      state.panning = true;
      state.panStart = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
      el.viewport.setPointerCapture(e.pointerId);
    }
  });

  el.viewport.addEventListener("pointermove", e => {
    if (!state.panning) return;
    state.panX = state.panStart.px + (e.clientX - state.panStart.x);
    state.panY = state.panStart.py + (e.clientY - state.panStart.y);
    applyTransform();
  });

  el.viewport.addEventListener("pointerup", e => {
    state.panning = false;
    try { el.viewport.releasePointerCapture(e.pointerId); } catch {}
  });

  window.addEventListener("keydown", e => {
    if (e.target === el.code) return;
    if (e.code === "Space") {
      state.space = true;
      e.preventDefault();
    }
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      state.follow = true;
      el.follow.checked = true;
      focusFrame();
    }
    if (e.key === "0") {
      e.preventDefault();
      fit();
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomAt(1.15, el.viewport.clientWidth / 2, el.viewport.clientHeight / 2);
    }
    if (e.key === "-") {
      e.preventDefault();
      zoomAt(.87, el.viewport.clientWidth / 2, el.viewport.clientHeight / 2);
    }
  });

  window.addEventListener("keyup", e => {
    if (e.code === "Space") state.space = false;
  });

  el.run.addEventListener("click", run);
  el.prev.addEventListener("click", () => setStep(state.step - 1));
  el.next.addEventListener("click", () => setStep(state.step + 1));
  el.play.addEventListener("click", play);
  el.reset.addEventListener("click", reset);
  el.range.addEventListener("input", e => setStep(Number(e.target.value)));
  el.follow.addEventListener("change", () => state.follow = el.follow.checked);
  el.fit.addEventListener("click", fit);
  el.hudFit.addEventListener("click", fit);
  el.focus.addEventListener("click", () => focusFrame());
  el.zoomIn.addEventListener("click", () => zoomAt(1.15, el.viewport.clientWidth / 2, el.viewport.clientHeight / 2));
  el.zoomOut.addEventListener("click", () => zoomAt(.87, el.viewport.clientWidth / 2, el.viewport.clientHeight / 2));
  el.hudZoomIn.addEventListener("click", () => zoomAt(1.15, el.viewport.clientWidth / 2, el.viewport.clientHeight / 2));
  el.hudZoomOut.addEventListener("click", () => zoomAt(.87, el.viewport.clientWidth / 2, el.viewport.clientHeight / 2));

  el.stackBtn.addEventListener("click", () => el.stackOverlay.classList.toggle("hidden"));
  el.memoryBtn.addEventListener("click", () => el.memoryOverlay.classList.toggle("hidden"));
  el.max.addEventListener("click", () => {
    state.max = !state.max;
    el.visual.classList.toggle("max", state.max);
    setTimeout(() => {
      if (state.max) focusFrame();
      else fit();
    }, 20);
  });

  el.viewButtons.forEach(button => {
    button.addEventListener("click", () => {
      state.viewMode = button.dataset.view || "execution";
      renderViewMode();
      if (state.viewMode === "memory" || state.viewMode === "split") {
        renderMemoryGraph(state.events[state.step] || null);
      }
    });
  });

  el.askBtn.addEventListener("click", askGenAI);
  el.askInput.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      askGenAI();
    }
  });

  window.addEventListener("resize", () => {
    if (state.max) focusFrame();
  });

  updateSource(null);
  renderViewMode();
})();
