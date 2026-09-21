/* =========================================================
   STATE
========================================================= */

let executionData = null;
let currentStep = 0;
let isPlaying = false;
let playTimer = null;


/* =========================================================
   DOM
========================================================= */

const codeEditor =
    document.getElementById("codeEditor");

const lineNumbers =
    document.getElementById("lineNumbers");

const languageSelect =
    document.getElementById("languageSelect");

const languageBadge =
    document.getElementById("languageBadge");

const runBtn =
    document.getElementById("runBtn");

const currentLine =
    document.getElementById("currentLine");

const stepInfo =
    document.getElementById("stepInfo");

const memoryObjectCount =
    document.getElementById("memoryObjectCount");

const memoryGraph =
    document.getElementById("memoryGraph");

const memoryObjects =
    document.getElementById("memoryObjects");

const memorySvg =
    document.getElementById("memorySvg");

const memoryEmpty =
    document.getElementById("memoryEmpty");

const eventType =
    document.getElementById("eventType");

const eventFunction =
    document.getElementById("eventFunction");

const eventDescription =
    document.getElementById("eventDescription");

const callStack =
    document.getElementById("callStack");

const variables =
    document.getElementById("variables");

const programOutput =
    document.getElementById("programOutput");

const prevBtn =
    document.getElementById("prevBtn");

const playBtn =
    document.getElementById("playBtn");

const nextBtn =
    document.getElementById("nextBtn");

const resetBtn =
    document.getElementById("resetBtn");


/* =========================================================
   DEFAULT CODE
========================================================= */

const defaultPythonCode = `class Node:
    def __init__(self, data):
        self.data = data
        self.left = None
        self.right = None

root = Node(10)
root.left = Node(5)
root.right = Node(20)

print(root.data)
print(root.left.data)
print(root.right.data)
`;

codeEditor.value = defaultPythonCode;


/* =========================================================
   LINE NUMBERS
========================================================= */

function updateLineNumbers(activeLine = null) {

    const lines =
        codeEditor.value.split("\n");

    lineNumbers.innerHTML = "";

    lines.forEach((_, index) => {

        const number =
            document.createElement("div");

        number.className = "line-number";

        const line = index + 1;

        if (line === activeLine) {
            number.classList.add("active");
        }

        number.textContent = line;

        lineNumbers.appendChild(number);
    });

    syncEditorScroll();
}


/* =========================================================
   EDITOR SCROLL
========================================================= */

function syncEditorScroll() {

    lineNumbers.scrollTop =
        codeEditor.scrollTop;
}


codeEditor.addEventListener(
    "scroll",
    syncEditorScroll
);


/* =========================================================
   EDITOR INPUT
========================================================= */

codeEditor.addEventListener(
    "input",
    () => {

        /*
         * User is editing the source.
         * Clear previous execution because it no longer
         * represents the current code.
         */

        if (executionData) {

            executionData = null;
            currentStep = 0;

            stopPlaying();

            resetVisualization();
        }

        updateLineNumbers();
    }
);


/* =========================================================
   TAB SUPPORT
========================================================= */

codeEditor.addEventListener(
    "keydown",
    (event) => {

        if (event.key !== "Tab") {
            return;
        }

        event.preventDefault();

        const start =
            codeEditor.selectionStart;

        const end =
            codeEditor.selectionEnd;

        const value =
            codeEditor.value;

        codeEditor.value =
            value.substring(0, start) +
            "    " +
            value.substring(end);

        codeEditor.selectionStart =
            start + 4;

        codeEditor.selectionEnd =
            start + 4;

        updateLineNumbers();
    }
);


/* =========================================================
   LANGUAGE
========================================================= */

languageSelect.addEventListener(
    "change",
    () => {

        const language =
            languageSelect.value;

        languageBadge.textContent =
            language === "python"
                ? "Python"
                : language === "cpp"
                    ? "C++"
                    : "Java";
    }
);


/* =========================================================
   RUN CODE
========================================================= */

runBtn.addEventListener(
    "click",
    runCode
);


async function runCode() {

    stopPlaying();

    runBtn.disabled = true;
    runBtn.textContent = "⏳ Running...";

    resetVisualization();

    const language =
        languageSelect.value;

    const code =
        codeEditor.value;

    try {

        const response =
            await fetch("/api/execute", {

                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    language: language,
                    code: code
                })
            });


        const raw =
            await response.text();


        let data;

        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error(
                raw || "Invalid response from server."
            );
        }


        executionData = data;


        if (data.error) {

            showError(data.error);

            return;
        }


        if (
            !data.events ||
            data.events.length === 0
        ) {

            showError(
                "No execution events were generated."
            );

            return;
        }


        currentStep = 0;

        renderStep();

    } catch (error) {

        showError(
            error.message || "Execution failed."
        );

    } finally {

        runBtn.disabled = false;
        runBtn.textContent = "▶ Run Code";
    }
}


/* =========================================================
   RENDER STEP
========================================================= */

function renderStep() {

    if (
        !executionData ||
        !executionData.events ||
        executionData.events.length === 0
    ) {
        return;
    }


    const events =
        executionData.events;

    const event =
        events[currentStep];


    if (!event) {
        return;
    }


    /* ---------- STEP ---------- */

    stepInfo.textContent =
        `Step ${currentStep + 1} / ${events.length}`;


    /* ---------- LINE ---------- */

    const line =
        event.line || 0;

    currentLine.textContent =
        line || "—";

    updateLineNumbers(line);

    scrollToLine(line);


    /* ---------- EVENT ---------- */

    eventType.textContent =
        event.event || "UNKNOWN";

    eventFunction.textContent =
        event.function
            ? event.function
            : "—";

    eventDescription.textContent =
        describeEvent(event);


    /* ---------- VARIABLES ---------- */

    renderVariables(
        event.variables || {}
    );


    /* ---------- CALL STACK ---------- */

    renderCallStack(
        event.callStack || []
    );


    /* ---------- MEMORY ---------- */

    renderMemory(
        event.objects || {},
        event.references || {}
    );


    /* ---------- OUTPUT ---------- */

    programOutput.textContent =
        executionData.output || "";


    /* ---------- BUTTONS ---------- */

    updateControls();
}


/* =========================================================
   SCROLL TO EXECUTING LINE
========================================================= */

function scrollToLine(line) {

    if (!line || line < 1) {
        return;
    }

    const lineHeight = 22;

    const target =
        (line - 1) * lineHeight;

    const visibleHeight =
        codeEditor.clientHeight;

    const currentScroll =
        codeEditor.scrollTop;

    const upper =
        target - 70;

    const lower =
        target + 70;

    if (target < currentScroll) {

        codeEditor.scrollTop =
            Math.max(0, upper);

    } else if (
        target + lineHeight >
        currentScroll + visibleHeight
    ) {

        codeEditor.scrollTop =
            lower - visibleHeight;
    }
}


/* =========================================================
   EVENT DESCRIPTION
========================================================= */

function describeEvent(event) {

    const type =
        event.event;

    switch (type) {

        case "LINE_EXECUTED":
            return `Executed line ${event.line}.`;

        case "FUNCTION_ENTER":
            return `Entered function ${event.function}().`;

        case "FUNCTION_EXIT":
            return `Returned from function ${event.function}().`;

        case "MEMORY_READ":
            return "Read a value from memory.";

        case "MEMORY_WRITE":
            return "Updated a value in memory.";

        case "CACHE_HIT":
            return "Found the requested value in the cache.";

        case "CACHE_MISS":
            return "Value was not found in the cache.";

        case "CONDITION_EVALUATED":
            return "A condition was evaluated.";

        case "ERROR":
            return "An error occurred during execution.";

        default:
            return "Execution event recorded.";
    }
}


/* =========================================================
   VARIABLES
========================================================= */

function renderVariables(data) {

    variables.innerHTML = "";

    const entries =
        Object.entries(data);

    if (entries.length === 0) {

        variables.innerHTML =
            `<div class="empty-panel">
                No variables in this frame.
            </div>`;

        return;
    }


    entries.forEach(
        ([name, value]) => {

            const row =
                document.createElement("div");

            row.className =
                "variable-row";


            const nameElement =
                document.createElement("span");

            nameElement.className =
                "variable-name";

            nameElement.textContent =
                name;


            const valueElement =
                document.createElement("span");

            valueElement.className =
                "variable-value";

            valueElement.textContent =
                formatValue(value);


            row.appendChild(nameElement);
            row.appendChild(valueElement);

            variables.appendChild(row);
        }
    );
}


/* =========================================================
   VALUE FORMATTER
========================================================= */

function formatValue(value) {

    if (value === null ||
        value === undefined) {

        return "null";
    }


    if (
        typeof value === "object" &&
        value.objectId
    ) {

        return `→ ${value.objectId}`;
    }


    if (
        typeof value === "object" &&
        value.type &&
        value.value !== undefined
    ) {

        return String(value.value);
    }


    return String(value);
}


/* =========================================================
   CALL STACK
========================================================= */

function renderCallStack(stack) {

    callStack.innerHTML = "";


    if (!stack || stack.length === 0) {

        callStack.innerHTML =
            `<div class="empty-panel">
                No active function calls.
            </div>`;

        return;
    }


    /*
     * Show current frame first.
     */

    const reversed =
        [...stack].reverse();


    reversed.forEach(
        (frame) => {

            const row =
                document.createElement("div");

            row.className =
                "stack-item";


            const functionName =
                document.createElement("span");

            functionName.className =
                "stack-function";

            functionName.textContent =
                frame.function || "<module>";


            const frameId =
                document.createElement("span");

            frameId.className =
                "stack-id";

            frameId.textContent =
                frame.frameId || "";


            row.appendChild(functionName);
            row.appendChild(frameId);

            callStack.appendChild(row);
        }
    );
}


/* =========================================================
   MEMORY VISUALIZATION
========================================================= */

function renderMemory(objects, references) {

    memoryObjects.innerHTML = "";
    memorySvg.innerHTML = "";

    removeRootReferences();


    const objectEntries =
        Object.entries(objects || {});


    memoryObjectCount.textContent =
        `${objectEntries.length} ${
            objectEntries.length === 1
                ? "object"
                : "objects"
        }`;


    if (objectEntries.length === 0) {

        memoryEmpty.style.display =
            "block";

        return;
    }


    memoryEmpty.style.display =
        "none";


    /*
     * Find root objects.
     */

    const roots = [];

    Object.entries(references || {})
        .forEach(
            ([name, objectId]) => {

                if (
                    objectId &&
                    objects[objectId]
                ) {

                    roots.push({
                        name,
                        objectId
                    });
                }
            }
        );


    /*
     * Calculate graph positions.
     */

    const positions =
        calculatePositions(
            objects,
            roots
        );


    /*
     * Create root labels.
     */

    roots.forEach(
        (root, index) => {

            createRootReference(
                root,
                positions[root.objectId],
                index
            );
        }
    );


    /*
     * Create object cards.
     */

    objectEntries.forEach(
        ([objectId, object]) => {

            const position =
                positions[objectId];

            if (!position) {
                return;
            }

            createMemoryObject(
                objectId,
                object,
                position
            );
        }
    );


    /*
     * Draw arrows after cards exist.
     */

    requestAnimationFrame(
        () => {

            drawMemoryEdges(
                objects,
                positions
            );
        }
    );
}


/* =========================================================
   POSITION CALCULATION
========================================================= */

function calculatePositions(
    objects,
    roots
) {

    const positions = {};

    const visited =
        new Set();

    const levels = {};


    /*
     * Start BFS from roots.
     */

    const queue = [];


    roots.forEach(
        root => {

            queue.push({
                id: root.objectId,
                depth: 0
            });
        }
    );


    /*
     * If there are no roots,
     * simply place objects in levels.
     */

    if (queue.length === 0) {

        Object.keys(objects)
            .forEach(
                (id, index) => {

                    queue.push({
                        id,
                        depth:
                            Math.floor(index / 4)
                    });
                }
            );
    }


    while (queue.length > 0) {

        const current =
            queue.shift();

        const id =
            current.id;

        const depth =
            current.depth;


        if (visited.has(id)) {
            continue;
        }

        if (!objects[id]) {
            continue;
        }


        visited.add(id);


        if (!levels[depth]) {
            levels[depth] = [];
        }

        levels[depth].push(id);


        const fields =
            objects[id].fields || {};


        Object.values(fields)
            .forEach(
                value => {

                    if (
                        typeof value === "string" &&
                        value.startsWith("obj_") &&
                        objects[value]
                    ) {

                        queue.push({
                            id: value,
                            depth: depth + 1
                        });
                    }
                }
            );
    }


    /*
     * Add objects not reached from roots.
     */

    Object.keys(objects)
        .forEach(
            id => {

                if (visited.has(id)) {
                    return;
                }

                let depth = 0;

                while (
                    levels[depth] &&
                    levels[depth].length >= 4
                ) {
                    depth++;
                }

                if (!levels[depth]) {
                    levels[depth] = [];
                }

                levels[depth].push(id);
            }
        );


    /*
     * Convert levels into pixel positions.
     */

    Object.entries(levels)
        .forEach(
            ([depthString, ids]) => {

                const depth =
                    Number(depthString);

                ids.forEach(
                    (id, index) => {

                        positions[id] = {

                            x:
                                70 +
                                index * 235,

                            y:
                                55 +
                                depth * 180
                        };
                    }
                );
            }
        );


    return positions;
}


/* =========================================================
   CREATE ROOT REFERENCE
========================================================= */

function createRootReference(
    root,
    position,
    index
) {

    if (!position) {
        return;
    }


    const element =
        document.createElement("div");

    element.className =
        "root-reference";


    element.style.left =
        `${position.x + 48}px`;

    element.style.top =
        `${Math.max(8, position.y - 40)}px`;


    element.innerHTML = `
        <span class="root-icon">●</span>
        <span>${escapeHtml(root.name)}</span>
    `;


    memoryObjects.appendChild(element);
}


/* =========================================================
   REMOVE ROOT REFERENCES
========================================================= */

function removeRootReferences() {

    document
        .querySelectorAll(".root-reference")
        .forEach(
            element => element.remove()
        );
}


/* =========================================================
   CREATE MEMORY OBJECT
========================================================= */

function createMemoryObject(
    objectId,
    object,
    position
) {

    const card =
        document.createElement("div");

    card.className =
        "memory-object";


    card.dataset.objectId =
        objectId;


    card.style.left =
        `${position.x}px`;

    card.style.top =
        `${position.y}px`;


    const header =
        document.createElement("div");

    header.className =
        "object-header";


    header.innerHTML = `
        <div class="object-name">
            <span class="object-dot"></span>
            ${escapeHtml(object.type || "Object")}
        </div>

        <div class="object-id">
            ${escapeHtml(objectId)}
        </div>
    `;


    const fields =
        document.createElement("div");

    fields.className =
        "object-fields";


    Object.entries(
        object.fields || {}
    ).forEach(
        ([fieldName, value]) => {

            const row =
                document.createElement("div");

            row.className =
                "object-field";


            const name =
                document.createElement("span");

            name.className =
                "field-name";

            name.textContent =
                fieldName;


            const valueElement =
                document.createElement("span");

            valueElement.className =
                "field-value";


            if (
                typeof value === "string" &&
                value.startsWith("obj_")
            ) {

                valueElement.classList.add(
                    "reference"
                );

                valueElement.textContent =
                    `→ ${value}`;

            } else if (
                value === null ||
                value === undefined
            ) {

                valueElement.classList.add(
                    "null"
                );

                valueElement.textContent =
                    "null";

            } else if (
                typeof value === "object" &&
                value.type
            ) {

                const actualValue =
                    value.value !== undefined
                        ? value.value
                        : value.type;

                valueElement.textContent =
                    String(actualValue);

                if (
                    value.type === "int" ||
                    value.type === "float"
                ) {
                    valueElement.classList.add(
                        "number"
                    );
                }

            } else {

                valueElement.textContent =
                    String(value);
            }


            row.appendChild(name);
            row.appendChild(valueElement);

            fields.appendChild(row);
        }
    );


    card.appendChild(header);
    card.appendChild(fields);

    memoryObjects.appendChild(card);
}


/* =========================================================
   DRAW MEMORY EDGES
========================================================= */

function drawMemoryEdges(
    objects,
    positions
) {

    memorySvg.innerHTML = "";


    /*
     * Arrow marker
     */

    const defs =
        document.createElementNS(
            "http://www.w3.org/2000/svg",
            "defs"
        );


    const marker =
        document.createElementNS(
            "http://www.w3.org/2000/svg",
            "marker"
        );


    marker.setAttribute(
        "id",
        "arrow"
    );

    marker.setAttribute(
        "markerWidth",
        "7"
    );

    marker.setAttribute(
        "markerHeight",
        "7"
    );

    marker.setAttribute(
        "refX",
        "6"
    );

    marker.setAttribute(
        "refY",
        "3.5"
    );

    marker.setAttribute(
        "orient",
        "auto"
    );


    const polygon =
        document.createElementNS(
            "http://www.w3.org/2000/svg",
            "polygon"
        );

    polygon.setAttribute(
        "points",
        "0 0, 7 3.5, 0 7"
    );

    polygon.setAttribute(
        "fill",
        "#71849e"
    );


    marker.appendChild(polygon);
    defs.appendChild(marker);
    memorySvg.appendChild(defs);


    /*
     * Draw each object reference.
     */

    Object.entries(objects)
        .forEach(
            ([sourceId, object]) => {

                const source =
                    positions[sourceId];

                if (!source) {
                    return;
                }


                Object.entries(
                    object.fields || {}
                ).forEach(
                    ([fieldName, value]) => {

                        if (
                            typeof value !== "string" ||
                            !value.startsWith("obj_")
                        ) {
                            return;
                        }


                        const target =
                            positions[value];

                        if (!target) {
                            return;
                        }


                        const startX =
                            source.x + 190;

                        const startY =
                            source.y + 62;


                        const endX =
                            target.x;

                        const endY =
                            target.y + 60;


                        const distance =
                            Math.abs(endX - startX);


                        const curve =
                            Math.max(
                                45,
                                distance * 0.45
                            );


                        const path =
                            document.createElementNS(
                                "http://www.w3.org/2000/svg",
                                "path"
                            );


                        const d =
                            `
                            M ${startX} ${startY}
                            C
                            ${startX + curve} ${startY},
                            ${endX - curve} ${endY},
                            ${endX} ${endY}
                            `;


                        path.setAttribute(
                            "d",
                            d
                        );

                        path.setAttribute(
                            "class",
                            "memory-edge"
                        );

                        path.setAttribute(
                            "marker-end",
                            "url(#arrow)"
                        );


                        memorySvg.appendChild(
                            path
                        );


                        /*
                         * Field label
                         */

                        const label =
                            document.createElementNS(
                                "http://www.w3.org/2000/svg",
                                "text"
                            );


                        const labelX =
                            (startX + endX) / 2;

                        const labelY =
                            (startY + endY) / 2 - 5;


                        label.setAttribute(
                            "x",
                            labelX
                        );

                        label.setAttribute(
                            "y",
                            labelY
                        );

                        label.setAttribute(
                            "class",
                            "edge-label"
                        );

                        label.setAttribute(
                            "text-anchor",
                            "middle"
                        );

                        label.textContent =
                            fieldName;


                        memorySvg.appendChild(
                            label
                        );
                    }
                );
            }
        );
}


/* =========================================================
   RESET
========================================================= */

resetBtn.addEventListener(
    "click",
    () => {

        stopPlaying();

        if (
            executionData &&
            executionData.events &&
            executionData.events.length
        ) {

            currentStep = 0;

            renderStep();

        } else {

            resetVisualization();
        }
    }
);


function resetVisualization() {

    currentStep = 0;

    currentLine.textContent =
        "—";

    stepInfo.textContent =
        "Step 0 / 0";

    eventType.textContent =
        "—";

    eventFunction.textContent =
        "—";

    eventDescription.textContent =
        "Run the program to begin execution.";

    renderVariables({});

    renderCallStack([]);

    memoryObjects.innerHTML = "";
    memorySvg.innerHTML = "";

    removeRootReferences();

    memoryEmpty.style.display =
        "block";

    memoryObjectCount.textContent =
        "0 objects";

    updateLineNumbers();
    updateControls();
}


/* =========================================================
   PREVIOUS
========================================================= */

prevBtn.addEventListener(
    "click",
    () => {

        if (!executionData) {
            return;
        }

        if (currentStep > 0) {

            currentStep--;

            renderStep();
        }
    }
);


/* =========================================================
   NEXT
========================================================= */

nextBtn.addEventListener(
    "click",
    () => {

        if (!executionData) {
            return;
        }


        if (
            currentStep <
            executionData.events.length - 1
        ) {

            currentStep++;

            renderStep();

        } else {

            stopPlaying();
        }
    }
);


/* =========================================================
   PLAY / PAUSE
========================================================= */

playBtn.addEventListener(
    "click",
    () => {

        if (!executionData) {
            return;
        }


        if (isPlaying) {

            stopPlaying();

        } else {

            startPlaying();
        }
    }
);


function startPlaying() {

    if (!executionData) {
        return;
    }


    if (
        currentStep >=
        executionData.events.length - 1
    ) {

        currentStep = 0;

        renderStep();
    }


    isPlaying = true;

    playBtn.textContent =
        "❚❚ Pause";


    playTimer =
        setInterval(
            () => {

                if (
                    currentStep >=
                    executionData.events.length - 1
                ) {

                    stopPlaying();

                    return;
                }


                currentStep++;

                renderStep();

            },
            650
        );
}


function stopPlaying() {

    isPlaying = false;

    clearInterval(playTimer);

    playTimer = null;

    playBtn.textContent =
        "▶ Play";
}


/* =========================================================
   CONTROLS
========================================================= */

function updateControls() {

    const hasData =
        executionData &&
        executionData.events &&
        executionData.events.length > 0;


    prevBtn.disabled =
        !hasData ||
        currentStep <= 0;


    nextBtn.disabled =
        !hasData ||
        currentStep >=
        executionData.events.length - 1;


    playBtn.disabled =
        !hasData;
}


/* =========================================================
   ERROR
========================================================= */

function showError(message) {

    executionData = null;

    currentStep = 0;

    eventType.textContent =
        "ERROR";

    eventFunction.textContent =
        "Execution";

    eventDescription.textContent =
        "The program could not be executed.";


    memoryObjects.innerHTML = "";

    memorySvg.innerHTML = "";

    removeRootReferences();

    memoryEmpty.style.display =
        "none";


    memoryObjectCount.textContent =
        "0 objects";


    variables.innerHTML = `
        <div class="error-message">
            ${escapeHtml(message)}
        </div>
    `;


    callStack.innerHTML = `
        <div class="empty-panel">
            Execution failed.
        </div>
    `;


    programOutput.textContent =
        "";


    updateControls();
}


/* =========================================================
   HTML ESCAPE
========================================================= */

function escapeHtml(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


/* =========================================================
   INITIALIZE
========================================================= */

updateLineNumbers();
updateControls();