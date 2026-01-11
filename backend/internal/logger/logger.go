// Package logger provides structured logging for the application.
package logger

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/aman1117/backend/internal/config"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Log is the main logger instance
var Log *zap.Logger

// Sugar is the sugared logger for convenience
var Sugar *zap.SugaredLogger

// axiomWriter sends logs to Axiom
type axiomWriter struct {
	url      string
	apiToken string
	buffer   []map[string]interface{}
	mu       sync.Mutex
	client   *http.Client
	stopChan chan struct{}
	env      string
}

var axiom *axiomWriter

// Init initializes the logger with the provided configuration
func Init(cfg *config.Config) {
	env := cfg.Env

	// JSON encoder config for Axiom
	jsonEncoderConfig := zapcore.EncoderConfig{
		TimeKey:        "timestamp",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "message",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.SecondsDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}

	// Console encoder config for development
	consoleEncoderConfig := zapcore.EncoderConfig{
		TimeKey:        "T",
		LevelKey:       "L",
		NameKey:        "N",
		CallerKey:      "C",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "M",
		StacktraceKey:  "S",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.CapitalColorLevelEncoder,
		EncodeTime:     zapcore.TimeEncoderOfLayout("15:04:05"),
		EncodeDuration: zapcore.StringDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}

	var cores []zapcore.Core

	if cfg.IsProduction() {
		// Production: JSON to stdout
		cores = append(cores, zapcore.NewCore(
			zapcore.NewJSONEncoder(jsonEncoderConfig),
			zapcore.AddSync(os.Stdout),
			zap.DebugLevel,
		))

		// Add Axiom if configured
		if cfg.Axiom.Dataset != "" && cfg.Axiom.APIToken != "" {
			axiom = newAxiomWriter(cfg.Axiom.Dataset, cfg.Axiom.APIToken, env)
			cores = append(cores, zapcore.NewCore(
				zapcore.NewJSONEncoder(jsonEncoderConfig),
				zapcore.AddSync(axiom),
				zap.DebugLevel,
			))
		}
	} else {
		// Development: Pretty colored console output
		cores = append(cores, zapcore.NewCore(
			zapcore.NewConsoleEncoder(consoleEncoderConfig),
			zapcore.AddSync(os.Stdout),
			zap.DebugLevel,
		))
	}

	Log = zap.New(zapcore.NewTee(cores...))
	Sugar = Log.Sugar()
}

// Sync flushes any buffered log entries
func Sync() {
	if Log != nil {
		_ = Log.Sync()
	}
	if axiom != nil {
		axiom.stop()
	}
}

// newAxiomWriter creates a new Axiom writer
func newAxiomWriter(dataset, apiToken, env string) *axiomWriter {
	aw := &axiomWriter{
		url:      "https://api.axiom.co/v1/datasets/" + dataset + "/ingest",
		apiToken: apiToken,
		buffer:   make([]map[string]interface{}, 0, 100),
		client:   &http.Client{Timeout: 5 * time.Second},
		stopChan: make(chan struct{}),
		env:      env,
	}

	go aw.flushLoop()
	return aw
}

func (aw *axiomWriter) Write(p []byte) (n int, err error) {
	var entry map[string]interface{}
	if err := json.Unmarshal(p, &entry); err != nil {
		entry = map[string]interface{}{
			"message": string(p),
			"_time":   time.Now().Format(time.RFC3339Nano),
			"app":     "growth-tracker",
			"env":     aw.env,
		}
	} else {
		entry["_time"] = time.Now().Format(time.RFC3339Nano)
		entry["app"] = "growth-tracker"
		entry["env"] = aw.env
	}

	aw.mu.Lock()
	aw.buffer = append(aw.buffer, entry)
	aw.mu.Unlock()

	return len(p), nil
}

func (aw *axiomWriter) flushLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			aw.flush()
		case <-aw.stopChan:
			aw.flush()
			return
		}
	}
}

func (aw *axiomWriter) flush() {
	aw.mu.Lock()
	if len(aw.buffer) == 0 {
		aw.mu.Unlock()
		return
	}
	entries := aw.buffer
	aw.buffer = make([]map[string]interface{}, 0, 100)
	aw.mu.Unlock()

	jsonPayload, err := json.Marshal(entries)
	if err != nil {
		return
	}

	req, err := http.NewRequest("POST", aw.url, bytes.NewReader(jsonPayload))
	if err != nil {
		return
	}

	req.Header.Set("Authorization", "Bearer "+aw.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := aw.client.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

func (aw *axiomWriter) stop() {
	close(aw.stopChan)
}

// ==================== Context Loggers ====================

// LogWithUser returns a logger with user context
func LogWithUser(userID uint, username string) *zap.SugaredLogger {
	fields := []interface{}{}
	if userID > 0 {
		fields = append(fields, "user_id", userID)
	}
	if username != "" {
		fields = append(fields, "username", username)
	}
	return Sugar.With(fields...)
}

// LogWithUserID returns a logger with user_id field
func LogWithUserID(userID uint) *zap.SugaredLogger {
	if userID > 0 {
		return Sugar.With("user_id", userID)
	}
	return Sugar
}

// LogWithTrace returns a logger with trace_id field
func LogWithTrace(traceID string) *zap.SugaredLogger {
	if traceID != "" {
		return Sugar.With("trace_id", traceID)
	}
	return Sugar
}

// LogWithContext returns a logger with trace_id and user_id
func LogWithContext(traceID string, userID uint) *zap.SugaredLogger {
	fields := []interface{}{}
	if traceID != "" {
		fields = append(fields, "trace_id", traceID)
	}
	if userID > 0 {
		fields = append(fields, "user_id", userID)
	}
	return Sugar.With(fields...)
}

// LogWithFullContext returns a logger with trace_id, user_id, and username
func LogWithFullContext(traceID string, userID uint, username string) *zap.SugaredLogger {
	fields := []interface{}{}
	if traceID != "" {
		fields = append(fields, "trace_id", traceID)
	}
	if userID > 0 {
		fields = append(fields, "user_id", userID)
	}
	if username != "" {
		fields = append(fields, "username", username)
	}
	return Sugar.With(fields...)
}
