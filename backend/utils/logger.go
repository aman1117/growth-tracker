package utils

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var Log *zap.Logger
var Sugar *zap.SugaredLogger

// AxiomWriter sends logs to Axiom
type AxiomWriter struct {
	url      string
	apiToken string
	buffer   []map[string]interface{}
	mu       sync.Mutex
	client   *http.Client
	stopChan chan struct{}
}

// NewAxiomWriter creates a new Axiom writer
func NewAxiomWriter(dataset, apiToken string) *AxiomWriter {
	aw := &AxiomWriter{
		url:      "https://api.axiom.co/v1/datasets/" + dataset + "/ingest",
		apiToken: apiToken,
		buffer:   make([]map[string]interface{}, 0, 100),
		client:   &http.Client{Timeout: 5 * time.Second},
		stopChan: make(chan struct{}),
	}

	// Flush logs every 2 seconds
	go aw.flushLoop()

	return aw
}

func (aw *AxiomWriter) Write(p []byte) (n int, err error) {
	// Parse the JSON log entry
	var entry map[string]interface{}
	if err := json.Unmarshal(p, &entry); err != nil {
		// If not valid JSON, wrap it
		entry = map[string]interface{}{
			"message": string(p),
			"_time":   time.Now().Format(time.RFC3339Nano),
			"app":     "growth-tracker",
			"env":     os.Getenv("ENV"),
		}
	} else {
		// Add Axiom timestamp and metadata
		entry["_time"] = time.Now().Format(time.RFC3339Nano)
		entry["app"] = "growth-tracker"
		entry["env"] = os.Getenv("ENV")
	}

	aw.mu.Lock()
	aw.buffer = append(aw.buffer, entry)
	aw.mu.Unlock()

	return len(p), nil
}

func (aw *AxiomWriter) flushLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			aw.flush()
		case <-aw.stopChan:
			aw.flush() // Final flush
			return
		}
	}
}

func (aw *AxiomWriter) flush() {
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

func (aw *AxiomWriter) Stop() {
	close(aw.stopChan)
}

var axiomWriter *AxiomWriter

// InitLogger initializes the Zap logger
// Uses JSON format in production (for Axiom)
// Uses colored console format in development
func InitLogger() {
	env := os.Getenv("ENV")

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

	if env == "production" {
		// Production: JSON to stdout
		cores = append(cores, zapcore.NewCore(
			zapcore.NewJSONEncoder(jsonEncoderConfig),
			zapcore.AddSync(os.Stdout),
			zap.DebugLevel,
		))

		// Add Axiom if configured
		axiomDataset := os.Getenv("AXIOM_DATASET")
		axiomToken := os.Getenv("AXIOM_API_TOKEN")

		if axiomDataset != "" && axiomToken != "" {
			axiomWriter = NewAxiomWriter(axiomDataset, axiomToken)
			cores = append(cores, zapcore.NewCore(
				zapcore.NewJSONEncoder(jsonEncoderConfig),
				zapcore.AddSync(axiomWriter),
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

// SyncLogger flushes any buffered log entries
func SyncLogger() {
	if Log != nil {
		_ = Log.Sync()
	}
	if axiomWriter != nil {
		axiomWriter.Stop()
	}
}
