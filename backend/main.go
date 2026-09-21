package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
)

// ============================================================
// REQUEST / RESPONSE MODELS
// ============================================================

type ExecuteRequest struct {
	Language string `json:"language"`
	Code     string `json:"code"`
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

// ============================================================
// EXECUTE CODE
// ============================================================

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

		fmt.Fprint(
			w,
			string(output),
		)

		return
	}

	fmt.Fprint(
		w,
		string(output),
	)
}

// ============================================================
// MAIN
// ============================================================

func main() {

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

	// --------------------------------------------------------
	// FRONTEND ROUTE
	// --------------------------------------------------------

	http.HandleFunc(
		"/",
		frontendHandler,
	)

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

	err := http.ListenAndServe(
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
