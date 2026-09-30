package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/joho/godotenv"
	"google.golang.org/genai"
)

// ============================================================
// REQUEST / RESPONSE MODELS
// ============================================================

type ExecuteRequest struct {
	Language string `json:"language"`
	Code     string `json:"code"`
}

type ExplainRequest struct {
	Code  string `json:"code"`
	Trace any    `json:"trace"`
}
type AskRequest struct {
	Code     string `json:"code"`
	Question string `json:"question"`
	Trace    any    `json:"trace"`
}
type SemanticStep struct {
	Step        int    `json:"step"`
	Line        int    `json:"line"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Event       any    `json:"event"`
}

type ExecutionResponse struct {
	Success        bool             `json:"success"`
	Events         []map[string]any `json:"events"`
	SemanticSteps  []SemanticStep   `json:"semanticSteps"`
	AIExplanations []AIExplanation  `json:"aiExplanations"`
	Objects        any              `json:"objects"`
	References     any              `json:"references"`
	Output         string           `json:"output"`
	Error          any              `json:"error"`
}

type AIExplanation struct {
	Step        int    `json:"step"`
	Explanation string `json:"explanation"`
}

func buildAIContext(steps []SemanticStep) []map[string]any {
	context := []map[string]any{}

	for _, step := range steps {
		context = append(context, map[string]any{
			"step":        step.Step,
			"line":        step.Line,
			"type":        step.Type,
			"description": step.Description,
		})
	}

	return context
}

func generateAIExplanations(code string, steps []SemanticStep) ([]AIExplanation, error) {
	apiKey := os.Getenv("GEMINI_API_KEY")

	if apiKey == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY is not set")
	}

	ctx := context.Background()

	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey: apiKey,
	})

	if err != nil {
		return nil, err
	}

	aiContext := buildAIContext(steps)

	contextJSON, err := json.Marshal(aiContext)
	if err != nil {
		return nil, err
	}

	prompt := fmt.Sprintf(`
You are a programming tutor helping a college student understand program execution.

The program has already been executed by a real runtime.
The execution steps below are verified runtime information.

Your task is to generate ONE short explanation for EACH execution step.

SOURCE CODE:
%s

VERIFIED EXECUTION STEPS:
%s

Rules:
1. Explain only what is supported by the execution steps.
2. Do not invent variable values or execution behavior.
3. Keep each explanation short and student-friendly.
4. Explain what happened and, when useful, why it happened.
5. Preserve the exact step number.
6. Return ONLY valid JSON.
7. Return a JSON array in this format:

[
  {
    "step": 1,
    "explanation": "..."
  }
]

Do not include markdown.
Do not include code fences.
`, code, string(contextJSON))

	result, err := client.Models.GenerateContent(
		ctx,
		"gemini-3.5-flash-lite",
		genai.Text(prompt),
		nil,
	)

	if err != nil {
		return nil, err
	}

	responseText := strings.TrimSpace(result.Text())

	var explanations []AIExplanation

	if err := json.Unmarshal([]byte(responseText), &explanations); err != nil {
		return nil, fmt.Errorf("could not parse Gemini response: %w", err)
	}

	return explanations, nil
}

// ============================================================
// HEALTH CHECK
// ============================================================

func healthHandler(w http.ResponseWriter, r *http.Request) {

	w.Header().Set(
		"Content-Type",
		"application/json",
	)

	response := map[string]string{
		"status": "ok",
	}

	json.NewEncoder(w).Encode(response)
}

// ============================================================
// FRONTEND
// ============================================================

func frontendHandler(w http.ResponseWriter, r *http.Request) {

	switch r.URL.Path {

	case "/":
		http.ServeFile(w, r, "../frontend/index.html")

	case "/style.css":
		http.ServeFile(w, r, "../frontend/style.css")

	case "/app.js":
		http.ServeFile(w, r, "../frontend/app.js")

	default:
		http.NotFound(w, r)
	}
}

// --------------------------------------------------------
// GEN AI
// --------------------------------------------------------

func explainHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ExplainRequest

	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	ctx := context.Background()

	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  os.Getenv("GEMINI_API_KEY"),
		Backend: genai.BackendGeminiAPI,
	})

	if err != nil {
		http.Error(w, "Could not create Gemini client", http.StatusInternalServerError)
		return
	}

	traceJSON, err := json.Marshal(req.Trace)
	if err != nil {
		http.Error(w, "Could not process trace", http.StatusInternalServerError)
		return
	}

	prompt := fmt.Sprintf(`
You are a programming tutor.

ExplainRequestthe execution of the following program to a college student.

Use ONLY the verified execution trace provided below.
Do not invent execution steps, variable values, or behavior.

SOURCE CODE:
%s

EXECUTION TRACE:
%s

Give a simple explanation of what happened during execution.
Focus on:
1. What the important execution step did.
2. How the variable values changed.
3. Why the result occurred.
4. Any relevant function call or memory behavior.

Keep the explanation concise and student-friendly.
`, req.Code, string(traceJSON))

	contents := []*genai.Content{
		genai.NewContentFromText(prompt, genai.RoleUser),
	}

	response, err := client.Models.GenerateContent(
		ctx,
		"gemini-3.6-flash",
		contents,
		nil,
	)

	if err != nil {
		http.Error(w, "Gemini API error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	result := map[string]string{
		"explanation": response.Text(),
	}

	json.NewEncoder(w).Encode(result)
}
func askHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AskRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	req.Question = strings.TrimSpace(req.Question)

	if req.Question == "" {
		http.Error(w, "Question is required", http.StatusBadRequest)
		return
	}

	apiKey := os.Getenv("GEMINI_API_KEY")

	if apiKey == "" {
		http.Error(w, "GEMINI_API_KEY is not set", http.StatusInternalServerError)
		return
	}

	traceJSON, err := json.Marshal(req.Trace)

	if err != nil {
		http.Error(
			w,
			"Could not process execution context",
			http.StatusInternalServerError,
		)
		return
	}

	ctx := context.Background()

	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})

	if err != nil {
		http.Error(
			w,
			"Could not create Gemini client",
			http.StatusInternalServerError,
		)
		return
	}

	prompt := fmt.Sprintf(`
You are a programming tutor inside an interactive code-execution visualizer.

Answer the student's question using the SOURCE CODE and VERIFIED EXECUTION CONTEXT below.

SOURCE CODE:
%s

VERIFIED EXECUTION CONTEXT:
%s

STUDENT QUESTION:
%s

Rules:
1. Treat the execution context as the source of truth for runtime facts.
2. Do not invent variable values, function calls, memory states, or execution steps.
3. Explain the answer in simple language suitable for a college programming student.
4. If the question is about the current step, directly connect the answer to that step.
5. If useful, quote a very short source-code expression, but do not repeat the whole program.
6. If the context does not contain enough information to answer a runtime-specific question, say that clearly.
7. Keep the answer concise: normally 2–6 sentences.
`, req.Code, string(traceJSON), req.Question)

	result, err := client.Models.GenerateContent(
		ctx,
		"gemini-3.5-flash-lite",
		genai.Text(prompt),
		nil,
	)

	if err != nil {
		http.Error(
			w,
			"Gemini API error: "+err.Error(),
			http.StatusInternalServerError,
		)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	json.NewEncoder(w).Encode(map[string]string{
		"answer": strings.TrimSpace(result.Text()),
	})
}

// ============================================================
// EXECUTE CODE
// ============================================================

func buildSemanticSteps(events []map[string]any) []SemanticStep {
	steps := []SemanticStep{}
	stepNo := 1

	for _, e := range events {
		event, _ := e["event"].(string)

		// These are execution/debug events, not student-facing steps.
		if event == "LINE_EXECUTED" ||
			event == "CONDITION_EVALUATED" ||
			event == "FUNCTION_EXIT" {
			continue
		}

		line := 0
		if v, ok := e["line"].(float64); ok {
			line = int(v)
		}

		switch event {

		case "ASSIGNMENT":
			target, _ := e["target"].(map[string]any)
			name, _ := target["name"].(string)

			value := formatTraceValue(e["value"])

			if name != "" {
				steps = append(steps, SemanticStep{
					Step:        stepNo,
					Line:        line,
					Type:        "ASSIGNMENT",
					Description: name + " = " + value,
					Event:       e,
				})
				stepNo++
			}

		case "AUG_ASSIGNMENT":
			target, _ := e["target"].(map[string]any)
			name, _ := target["name"].(string)

			operator, _ := e["operator"].(string)
			value := formatTraceValue(e["value"])

			if name != "" {
				steps = append(steps, SemanticStep{
					Step:        stepNo,
					Line:        line,
					Type:        "AUG_ASSIGNMENT",
					Description: name + " " + operator + " → " + value,
					Event:       e,
				})
				stepNo++
			}

		case "EXPRESSION_RESULT":
			expression := formatExpression(e["expression"])
			result := formatTraceValue(e["result"])

			// Ignore instrumentation/helper expressions.
			if expression == "" ||
				strings.Contains(expression, "_expr_") {
				continue
			}

			// print(...) is useful because it corresponds to visible output.
			if expr, ok := e["expression"].(map[string]any); ok {
				if fn, ok := expr["function"].(map[string]any); ok {
					if name, ok := fn["name"].(string); ok && name == "print" {
						steps = append(steps, SemanticStep{
							Step:        stepNo,
							Line:        line,
							Type:        "OUTPUT",
							Description: "print(" + formatExpressionArguments(expr["arguments"]) + ")",
							Event:       e,
						})
						stepNo++
						continue
					}
				}
			}

			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        "EXPRESSION",
				Description: expression + " → " + result,
				Event:       e,
			})
			stepNo++

		case "CONDITION":
			condition := formatExpression(e["condition"])
			result := formatTraceValue(e["result"])

			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        "CONDITION",
				Description: condition + " → " + result,
				Event:       e,
			})
			stepNo++

		case "LOOP_ITERATION":
			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        "LOOP_ITERATION",
				Description: "Loop iteration",
				Event:       e,
			})
			stepNo++

		case "BREAK":
			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        "BREAK",
				Description: "Break: exit loop",
				Event:       e,
			})
			stepNo++

		case "CONTINUE":
			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        "CONTINUE",
				Description: "Continue: next iteration",
				Event:       e,
			})
			stepNo++

		case "FUNCTION_ENTER":
			function, _ := e["function"].(string)

			// Don't show module startup as a learning step.
			if function == "<module>" {
				continue
			}

			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        "FUNCTION_CALL",
				Description: "Call " + function + "()",
				Event:       e,
			})
			stepNo++

		case "MEMORY_READ", "MEMORY_WRITE",
			"ATTRIBUTE_READ", "ATTRIBUTE_WRITE",
			"CACHE_HIT", "CACHE_MISS":

			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        event,
				Description: humanizeMemoryEvent(event, e),
				Event:       e,
			})
			stepNo++

		case "ERROR":
			steps = append(steps, SemanticStep{
				Step:        stepNo,
				Line:        line,
				Type:        "ERROR",
				Description: "Execution error",
				Event:       e,
			})
			stepNo++
		}
	}

	return steps
}

func formatTraceValue(v any) string {
	if v == nil {
		return "null"
	}

	m, ok := v.(map[string]any)
	if !ok {
		return fmt.Sprint(v)
	}

	value, exists := m["value"]
	if !exists {
		if objectID, ok := m["objectId"].(string); ok {
			return objectID
		}
		return "value"
	}

	return fmt.Sprint(value)
}

func formatExpression(expr any) string {
	m, ok := expr.(map[string]any)
	if !ok {
		return ""
	}

	kind, _ := m["kind"].(string)

	switch kind {

	case "name":
		return fmt.Sprint(m["name"])

	case "constant":
		return fmt.Sprint(m["value"])

	case "binary_op":
		left := formatExpression(m["left"])
		right := formatExpression(m["right"])

		op := fmt.Sprint(m["operator"])

		operators := map[string]string{
			"Add":      "+",
			"Sub":      "-",
			"Mult":     "*",
			"Div":      "/",
			"Mod":      "%",
			"Pow":      "**",
			"FloorDiv": "//",
		}

		if symbol, ok := operators[op]; ok {
			op = symbol
		}

		return left + " " + op + " " + right

	case "call":
		fn := formatExpression(m["function"])
		args := formatExpressionArguments(m["arguments"])

		return fn + "(" + args + ")"

	case "compare":
		left := formatExpression(m["left"])

		ops, _ := m["ops"].([]any)
		comparators, _ := m["comparators"].([]any)

		if len(ops) > 0 && len(comparators) > 0 {
			op := fmt.Sprint(ops[0])

			operatorMap := map[string]string{
				"Lt":    "<",
				"LtE":   "<=",
				"Gt":    ">",
				"GtE":   ">=",
				"Eq":    "==",
				"NotEq": "!=",
			}

			if symbol, ok := operatorMap[op]; ok {
				op = symbol
			}

			return left + " " + op + " " + formatExpression(comparators[0])
		}

	case "unary_op":
		operand := formatExpression(m["operand"])
		op := fmt.Sprint(m["operator"])

		return op + operand
	}

	return ""
}

func formatExpressionArguments(args any) string {
	list, ok := args.([]any)
	if !ok {
		return ""
	}

	result := ""

	for i, arg := range list {
		if i > 0 {
			result += ", "
		}

		result += formatExpression(arg)
	}

	return result
}

func humanizeMemoryEvent(event string, e map[string]any) string {
	switch event {

	case "MEMORY_READ":
		return "Read a value from memory"

	case "MEMORY_WRITE":
		return "Write a value to memory"

	case "ATTRIBUTE_READ":
		return "Read an object attribute"

	case "ATTRIBUTE_WRITE":
		return "Updated an object attribute"

	case "CACHE_HIT":
		return "Found value in cache"

	case "CACHE_MISS":
		return "Value not found in cache"
	}

	return event
}

func executeHandler(w http.ResponseWriter, r *http.Request) {

	// --------------------------------------------------------
	// METHOD CHECK
	// --------------------------------------------------------

	if r.Method != http.MethodPost {

		http.Error(
			w,
			"Only POST method is allowed",
			http.StatusMethodNotAllowed,
		)

		return
	}

	// --------------------------------------------------------
	// READ REQUEST
	// --------------------------------------------------------

	var req ExecuteRequest

	err := json.NewDecoder(
		r.Body,
	).Decode(&req)

	if err != nil {

		http.Error(
			w,
			"Invalid JSON",
			http.StatusBadRequest,
		)

		return
	}

	// --------------------------------------------------------
	// LANGUAGE CHECK
	// --------------------------------------------------------

	if req.Language != "python" {

		http.Error(
			w,
			"Only Python is supported currently",
			http.StatusBadRequest,
		)

		return
	}

	// --------------------------------------------------------
	// CREATE TEMPORARY PYTHON FILE
	// --------------------------------------------------------

	tempFile, err := os.CreateTemp(
		"",
		"code-*.py",
	)

	if err != nil {

		http.Error(
			w,
			"Could not create temporary file",
			http.StatusInternalServerError,
		)

		return
	}

	tempFileName := tempFile.Name()

	// Delete temporary file after execution.
	defer os.Remove(tempFileName)

	// --------------------------------------------------------
	// WRITE USER CODE
	// --------------------------------------------------------

	_, err = tempFile.WriteString(
		req.Code,
	)

	if err != nil {

		tempFile.Close()

		http.Error(
			w,
			"Could not write code",
			http.StatusInternalServerError,
		)

		return
	}

	tempFile.Close()

	// --------------------------------------------------------
	// RUN PYTHON TRACER
	// --------------------------------------------------------

	cmd := exec.Command(
		"python3",
		"tracer/python_tracer.py",
		tempFileName,
	)

	output, err := cmd.CombinedOutput()

	// --------------------------------------------------------
	// RESPONSE
	// --------------------------------------------------------

	w.Header().Set(
		"Content-Type",
		"application/json",
	)

	// IMPORTANT:
	// The tracer itself produces the JSON response.
	//
	// Even when the user's Python code has an error,
	// the tracer returns useful JSON containing:
	//
	// success
	// events
	// objects
	// references
	// output
	// error

	if err != nil {
		http.Error(w, string(output), http.StatusInternalServerError)
		return
	}

	var execution map[string]any

	err = json.Unmarshal(output, &execution)
	if err != nil {
		http.Error(w, "Could not parse execution trace", http.StatusInternalServerError)
		return
	}

	events, _ := execution["events"].([]any)

	eventMaps := make([]map[string]any, 0, len(events))

	for _, event := range events {
		if m, ok := event.(map[string]any); ok {
			eventMaps = append(eventMaps, m)
		}
	}

	semanticSteps := buildSemanticSteps(eventMaps)

	execution["semanticSteps"] = semanticSteps

	// Generate all AI explanations in ONE Gemini request.
	aiExplanations, err := generateAIExplanations(req.Code, semanticSteps)

	if err != nil {
		// Code execution succeeded, so don't fail the entire request
		// if Gemini explanation generation fails.
		fmt.Println("AI explanation error:", err)
		aiExplanations = []AIExplanation{}
	}

	execution["aiExplanations"] = aiExplanations

	w.Header().Set("Content-Type", "application/json")

	json.NewEncoder(w).Encode(execution)
}

// ============================================================
// MAIN
// ============================================================

func main() {

	err := godotenv.Load()

	// --------------------------------------------------------
	// API ROUTES
	// --------------------------------------------------------

	http.HandleFunc(
		"/api/health",
		healthHandler,
	)

	http.HandleFunc(
		"/api/execute",
		executeHandler,
	)
	http.HandleFunc(
		"/api/ask",
		askHandler)

	// --------------------------------------------------------
	// FRONTEND ROUTE
	// --------------------------------------------------------

	http.HandleFunc(
		"/",
		frontendHandler,
	)
	// --------------------------------------------------------
	// gen ai handler
	// --------------------------------------------------------
	http.HandleFunc("/api/explain", explainHandler)

	// --------------------------------------------------------
	// START SERVER
	// --------------------------------------------------------

	fmt.Println(
		"========================================",
	)

	fmt.Println(
		"Code Execution Visualizer",
	)

	fmt.Println(
		"Server running on http://localhost:8080",
	)

	fmt.Println(
		"========================================",
	)

	err = http.ListenAndServe(
		":8080",
		nil,
	)

	if err != nil {

		fmt.Println(
			"Server error:",
			err,
		)
	}
}
