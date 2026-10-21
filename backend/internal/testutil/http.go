package testutil

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// Response is the result of a request sent with Do.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// JSON decodes the body into a generic map.
func (r Response) JSON(t testing.TB) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(r.Body, &out); err != nil {
		t.Fatalf("testutil: response is not a JSON object (status %d): %v\n%s", r.Status, err, r.Body)
	}
	return out
}

// Decode decodes the body into v.
func (r Response) Decode(t testing.TB, v any) {
	t.Helper()
	if err := json.Unmarshal(r.Body, v); err != nil {
		t.Fatalf("testutil: decode response (status %d): %v\n%s", r.Status, err, r.Body)
	}
}

// RequestOption customises a request sent with Do.
type RequestOption func(*http.Request)

// WithToken sets an "Authorization: Bearer <token>" header.
func WithToken(token string) RequestOption {
	return WithHeader("Authorization", "Bearer "+token)
}

// WithHeader sets a request header.
func WithHeader(key, value string) RequestOption {
	return func(r *http.Request) { r.Header.Set(key, value) }
}

// Do sends a request through app and returns the response. body may be nil, a string or
// []byte (sent as is; strings are labelled application/json) or any other value, which is
// JSON-encoded. Requests have no timeout, so slow CI machines cannot cause flaky failures.
func Do(t testing.TB, app *fiber.App, method, target string, body any, opts ...RequestOption) Response {
	t.Helper()
	var reader io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case []byte:
		reader = bytes.NewReader(b)
	case string:
		reader = strings.NewReader(b)
		contentType = fiber.MIMEApplicationJSON
	default:
		encoded, err := json.Marshal(b)
		if err != nil {
			t.Fatalf("testutil: encode request body: %v", err)
		}
		reader = bytes.NewReader(encoded)
		contentType = fiber.MIMEApplicationJSON
	}

	req := httptest.NewRequest(method, target, reader)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for _, opt := range opts {
		opt(req)
	}

	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("testutil: %s %s: %v", method, target, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("testutil: read response: %v", err)
	}
	return Response{Status: resp.StatusCode, Header: resp.Header, Body: data}
}

// AsUser returns middleware that authenticates every request as the given user, exactly as
// middleware.Auth does after validating a token (it sets the "user_id" and "username"
// locals). Mount it in front of a handler to test the handler in isolation.
func AsUser(id uint, username string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Locals("user_id", id)
		c.Locals("username", username)
		return c.Next()
	}
}

// Multipart builds a multipart/form-data body with one file part plus optional text fields.
// Send it with Do(..., body, WithHeader("Content-Type", contentType)).
func Multipart(t testing.TB, field, filename string, content []byte, fields map[string]string) (body []byte, contentType string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatalf("testutil: multipart field: %v", err)
		}
	}
	if field != "" {
		part, err := w.CreateFormFile(field, filename)
		if err != nil {
			t.Fatalf("testutil: multipart file: %v", err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatalf("testutil: multipart write: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("testutil: multipart close: %v", err)
	}
	return buf.Bytes(), w.FormDataContentType()
}
